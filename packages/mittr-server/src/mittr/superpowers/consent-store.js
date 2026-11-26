import { createHash, randomUUID } from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const invalid = () => ({ status: 'invalid', httpStatus: 400 });
const unavailable = () => ({ status: 'unavailable', httpStatus: 503 });
const conflict = () => ({ status: 'conflict', httpStatus: 409 });
const recordSchema = z.record(z.string(), z.unknown());
const identifierSchema = z.string().min(1).max(1024).refine((value) => value.trim().length > 0);
const exactKeys = (value, keys) => recordSchema.safeParse(value).success
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const identifier = (value) => identifierSchema.safeParse(value).success;
const revision = (value) => Number.isSafeInteger(value) && value >= 0;
const validOwner = (owner) => exactKeys(owner, ['accountID', 'runtimeID']) && identifier(owner.accountID) && owner.accountID !== '_none' && identifier(owner.runtimeID);
const keyFor = (value) => createHash('sha256').update(value).digest('hex');
const initial = () => ({ version: 1, revision: 0, default: 'off', offer: { status: 'unseen' }, sessions: [] });

const validDocument = (value) => {
  if (!exactKeys(value, ['version', 'revision', 'default', 'offer', 'sessions'])
    || value.version !== 1 || !revision(value.revision) || !['off', 'on'].includes(value.default)
    || !Array.isArray(value.sessions) || !value.sessions.every(identifier)
    || new Set(value.sessions).size !== value.sessions.length) return false;
  const offer = value.offer;
  if (exactKeys(offer, ['status']) && offer.status === 'answered') {
    return value.revision > 0 && (value.default === 'off' || value.sessions.length === 0);
  }
  if (value.default !== 'off' || value.sessions.length !== 0) return false;
  if (exactKeys(offer, ['status']) && offer.status === 'unseen') return value.revision === 0;
  return exactKeys(offer, ['status', 'id', 'sessionID', 'turnID']) && offer.status === 'claimed'
    && value.revision > 0 && identifier(offer.id) && identifier(offer.sessionID) && identifier(offer.turnID);
};

/** No ambient config lookup. root is a private, server-owned consent namespace. */
export function createConsentStore({ root, fs = nodeFs } = {}) {
  if (!identifier(root) || !path.isAbsolute(root)) throw new Error('Consent store requires an explicit absolute root');
  const directory = (owner) => path.join(root, keyFor(owner.runtimeID), keyFor(owner.accountID));
  const syncDirectory = (dir) => {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  const ensureDirectory = (dir) => {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST' || !fs.statSync(dir).isDirectory()) throw error;
    }
  };
  const read = (owner) => {
    if (!validOwner(owner)) return invalid();
    const file = path.join(directory(owner), 'consent.json');
    try {
      const document = JSON.parse(fs.readFileSync(file, 'utf8'));
      return validDocument(document) ? { status: 'ok', document } : unavailable();
    } catch (error) {
      return error?.code === 'ENOENT' ? { status: 'ok', document: initial() } : unavailable();
    }
  };

  // Synchronous transactions cannot interleave in this process. An exclusive
  // directory also excludes other processes. A crashed lock fails closed; never
  // guess it is stale and grant permission. Recovery is an administrator action.
  const mutate = (owner, expectedRevision, transition) => {
    if (!validOwner(owner) || !revision(expectedRevision)) return invalid();
    const dir = directory(owner);
    const lock = path.join(dir, 'consent.lock');
    let locked = false;
    let temporary;
    try {
      // The injected root is already provisioned durably by the host. Never
      // create ancestors above it. Sync even existing entries: a previous failed
      // attempt or another writer may have created them without completing sync.
      if (!fs.statSync(root).isDirectory()) return unavailable();
      const runtimeDir = path.dirname(dir);
      ensureDirectory(runtimeDir);
      syncDirectory(root);
      ensureDirectory(dir);
      syncDirectory(runtimeDir);
      fs.mkdirSync(lock, { mode: 0o700 });
      locked = true;
      const current = read(owner);
      if (current.status !== 'ok') return current;
      if (current.document.revision !== expectedRevision) return conflict();
      const next = transition(current.document);
      if (next.status !== 'ok' || !next.changed) return next;
      if (expectedRevision === Number.MAX_SAFE_INTEGER) return unavailable();
      next.document.revision = expectedRevision + 1;
      if (!validDocument(next.document)) return unavailable();
      temporary = path.join(dir, `consent.${randomUUID()}.tmp`);
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(next.document)}\n`, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, path.join(dir, 'consent.json'));
      temporary = undefined;
      syncDirectory(dir);
      const { changed, ...result } = next;
      return result;
    } catch {
      return unavailable();
    } finally {
      if (temporary) {
        try { fs.unlinkSync(temporary); } catch { /* Never replace the prior consent to repair cleanup. */ }
      }
      if (locked) {
        try { fs.rmdirSync(lock); } catch { /* A retained lock denies future writes. */ }
      }
    }
  };
  const updated = (document, fields, outcome) => {
    const result = { status: 'ok', changed: true, document: { ...document, ...fields } };
    if (outcome) result.outcome = outcome;
    return result;
  };

  const claimOffer = (owner, input) => {
    if (!exactKeys(input, ['sessionID', 'turnID', 'expectedRevision']) || !identifier(input.sessionID) || !identifier(input.turnID)) return invalid();
    return mutate(owner, input.expectedRevision, (document) => {
      if (document.offer.status !== 'unseen') return { status: 'ok', document, outcome: document.offer.status === 'answered' ? 'answered' : 'already-claimed' };
      return updated(document, { offer: { status: 'claimed', id: randomUUID(), sessionID: input.sessionID, turnID: input.turnID } }, 'claimed');
    });
  };
  const answerOffer = (owner, input) => {
    if (!exactKeys(input, ['sessionID', 'offerID', 'decision', 'expectedRevision']) || !identifier(input.sessionID)
      || !identifier(input.offerID) || !['remember', 'chat', 'decline'].includes(input.decision)) return invalid();
    return mutate(owner, input.expectedRevision, (document) => {
      if (document.offer.status !== 'claimed' || document.offer.id !== input.offerID || document.offer.sessionID !== input.sessionID) return invalid();
      return updated(document, {
        default: input.decision === 'remember' ? 'on' : 'off',
        sessions: input.decision === 'chat' ? [input.sessionID] : [],
        offer: { status: 'answered' },
      });
    });
  };
  const setDefault = (owner, input) => {
    if (!exactKeys(input, ['enabled', 'expectedRevision']) || !z.boolean().safeParse(input.enabled).success) return invalid();
    return mutate(owner, input.expectedRevision, (document) => updated(document, { default: input.enabled ? 'on' : 'off', sessions: [], offer: { status: 'answered' } }));
  };
  const deleteSession = (owner, input) => {
    if (!exactKeys(input, ['sessionID', 'expectedRevision']) || !identifier(input.sessionID)) return invalid();
    return mutate(owner, input.expectedRevision, (document) => {
      // An abandoned claimed offer remains claimed, never eligible for re-offer.
      if (!document.sessions.includes(input.sessionID)) return { status: 'ok', document };
      return updated(document, { sessions: document.sessions.filter((id) => id !== input.sessionID) });
    });
  };
  return { read, claimOffer, answerOffer, setDefault, deleteSession };
}

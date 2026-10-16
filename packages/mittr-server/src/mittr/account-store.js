import { createHash, randomBytes } from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';

import { parseSession } from './session.js';

/**
 * Every Mittr account signed in on this machine, in the layout 1.x wrote:
 * `<dataDir>/mittr-accounts/index.json` lists them as
 * `{ active, accounts: [{ userId, displayName, home, signedIn }] }`, and each
 * account's session sits sealed in `<sha256(userId) hex, first 16>.session`.
 * The first account keeps the shared engine history (`home: null`); each later
 * one gets that 16-hex key as its own home.
 */

const ACCOUNTS_DIR = 'mittr-accounts';
const INDEX_FILE = 'index.json';
const LEGACY_SESSION_FILE = 'mittr-session';
const ACCOUNT_HOME = /^[0-9a-f]{16}$/;

const keyOf = (userId) => createHash('sha256').update(userId).digest('hex').slice(0, 16);

const emptyIndex = () => ({ active: null, accounts: [] });

export const accountIndexPath = (dataDir) => path.join(dataDir, ACCOUNTS_DIR, INDEX_FILE);

/**
 * The one parser of `index.json`. Throws on text that is not JSON; any other
 * malformed shape reads as no accounts, and `active` is kept only when it
 * names a signed-in account.
 */
export const parseAccountIndex = (raw) => {
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || !Array.isArray(value.accounts)) return emptyIndex();
  const accounts = value.accounts
    .filter((entry) => entry && typeof entry.userId === 'string' && entry.userId)
    .map((entry) => ({
      userId: entry.userId,
      displayName: typeof entry.displayName === 'string' ? entry.displayName : '',
      home: typeof entry.home === 'string' && ACCOUNT_HOME.test(entry.home) ? entry.home : null,
      signedIn: entry.signedIn === true,
    }));
  const active = accounts.some((entry) => entry.userId === value.active && entry.signedIn) ? value.active : null;
  return { active, accounts };
};

export function createAccountStore({ dataDir, encrypt, decrypt, fs = nodeFs, logger = console }) {
  const root = path.join(dataDir, ACCOUNTS_DIR);
  const indexPath = accountIndexPath(dataDir);
  const sessionPath = (userId) => path.join(root, `${keyOf(userId)}.session`);

  // Written beside the target and renamed over it, so a crash mid-write
  // leaves the old file whole rather than a truncated one.
  const writePrivate = (filePath, content) => {
    fs.mkdirSync(root, { recursive: true });
    const temporary = `${filePath}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, content, { mode: 0o600 });
      if (process.platform !== 'win32') fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, filePath);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  };

  // Missing means no accounts yet; anything else that cannot be read throws.
  const loadIndex = () => {
    let raw;
    try {
      raw = fs.readFileSync(indexPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyIndex();
      throw error;
    }
    return parseAccountIndex(raw);
  };

  const readIndex = () => {
    try {
      return loadIndex();
    } catch {
      return emptyIndex();
    }
  };

  // An index that exists but cannot be read is never written over: a fresh
  // one would give the next account the first account's engine history.
  const indexForWrite = () => {
    try {
      return loadIndex();
    } catch (error) {
      logger.error(`[mittr] the account index at ${indexPath} cannot be read; leaving it as it is:`, error?.message ?? error);
      throw new Error('The Mittr account index cannot be read');
    }
  };

  const writeIndex = (index) => writePrivate(indexPath, JSON.stringify(index, null, 2));

  const readSessionOf = (userId) => {
    try {
      return parseSession(JSON.parse(decrypt(fs.readFileSync(sessionPath(userId)))));
    } catch {
      // Unreadable or malformed is the same as never having signed in, and
      // signing in again costs one click.
      return null;
    }
  };

  const upsert = (index, session, activate = true) => {
    const parsed = parseSession(session);
    const { userId, displayName } = parsed.subject;
    writePrivate(sessionPath(userId), encrypt(JSON.stringify(parsed)));
    const known = index.accounts.find((entry) => entry.userId === userId);
    if (known) {
      known.displayName = displayName || known.displayName;
      known.signedIn = true;
    } else {
      index.accounts.push({
        userId,
        displayName,
        home: index.accounts.length === 0 ? null : keyOf(userId),
        signedIn: true,
      });
    }
    if (activate || !index.active) index.active = userId;
    return index;
  };

  // 1.x before multi-account kept one session at `<dataDir>/mittr-session`.
  // It becomes the first account, once; one that cannot be decrypted stays.
  const carryLegacySession = () => {
    const legacyPath = path.join(dataDir, LEGACY_SESSION_FILE);
    if (!fs.existsSync(legacyPath)) return;
    let index;
    try {
      index = indexForWrite();
    } catch {
      return;
    }
    if (index.accounts.length === 0) {
      try {
        const session = parseSession(JSON.parse(decrypt(fs.readFileSync(legacyPath))));
        writeIndex(upsert(index, session));
      } catch {
        return;
      }
    }
    try {
      fs.rmSync(legacyPath, { force: true });
    } catch {
      // Left for the next start.
    }
  };

  carryLegacySession();

  const read = () => {
    const index = readIndex();
    return index.active ? readSessionOf(index.active) : null;
  };

  // The session of an account that is signed in, active or not.
  const readOf = (userId) => {
    const entry = readIndex().accounts.find((candidate) => candidate.userId === userId);
    return entry?.signedIn ? readSessionOf(userId) : null;
  };

  const write = (session, { activate = true } = {}) => {
    writeIndex(upsert(indexForWrite(), session, activate));
  };

  const signOut = (userId) => {
    const index = indexForWrite();
    const entry = index.accounts.find((candidate) => candidate.userId === userId);
    if (!entry) return;
    entry.signedIn = false;
    fs.rmSync(sessionPath(userId), { force: true });
    if (index.active === userId) {
      index.active = index.accounts.find((candidate) => candidate.signedIn)?.userId ?? null;
    }
    writeIndex(index);
  };

  const clear = () => {
    const index = indexForWrite();
    if (index.active) signOut(index.active);
  };

  const activate = (userId) => {
    const index = indexForWrite();
    const entry = index.accounts.find((candidate) => candidate.userId === userId);
    if (!entry || !entry.signedIn) throw new Error('That account is not signed in on this machine');
    index.active = userId;
    writeIndex(index);
  };

  const list = () => {
    const index = readIndex();
    return index.accounts
      .filter((entry) => entry.signedIn)
      .map((entry) => ({ userId: entry.userId, displayName: entry.displayName, active: entry.userId === index.active }));
  };

  const activeHome = () => {
    const index = readIndex();
    return index.accounts.find((entry) => entry.userId === index.active)?.home ?? null;
  };

  return { read, readOf, write, clear, activate, signOut, list, activeHome };
}

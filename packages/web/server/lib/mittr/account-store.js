import nodeFs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseSession } from './session.js';

const ACCOUNTS_DIR = 'mittr-accounts';
const INDEX_FILE = 'index.json';
const LEGACY_SESSION_FILE = 'mittr-session';

const keyOf = (userId) => createHash('sha256').update(userId).digest('hex').slice(0, 16);

const emptyIndex = () => ({ active: null, accounts: [] });

const parseIndex = (raw) => {
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || !Array.isArray(value.accounts)) return emptyIndex();
  const accounts = value.accounts
    .filter((entry) => entry && typeof entry.userId === 'string' && entry.userId)
    .map((entry) => ({
      userId: entry.userId,
      displayName: typeof entry.displayName === 'string' ? entry.displayName : '',
      home: typeof entry.home === 'string' && /^[0-9a-f]{16}$/.test(entry.home) ? entry.home : null,
      signedIn: entry.signedIn === true,
    }));
  const active = accounts.some((entry) => entry.userId === value.active && entry.signedIn) ? value.active : null;
  return { active, accounts };
};

export function createAccountStore({ dataDir, encrypt, decrypt, fsImpl = nodeFs }) {
  const root = path.join(dataDir, ACCOUNTS_DIR);
  const indexPath = path.join(root, INDEX_FILE);
  const sessionPath = (userId) => path.join(root, `${keyOf(userId)}.session`);

  const writePrivate = (filePath, content) => {
    fsImpl.mkdirSync(root, { recursive: true });
    fsImpl.writeFileSync(filePath, content, { mode: 0o600 });
    if (process.platform !== 'win32') fsImpl.chmodSync(filePath, 0o600);
  };

  const readIndex = () => {
    try {
      return parseIndex(fsImpl.readFileSync(indexPath, 'utf8'));
    } catch {
      return emptyIndex();
    }
  };

  const writeIndex = (index) => writePrivate(indexPath, JSON.stringify(index, null, 2));

  const readSessionOf = (userId) => {
    try {
      return parseSession(JSON.parse(decrypt(fsImpl.readFileSync(sessionPath(userId)))));
    } catch {
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

  const carryLegacySession = () => {
    const legacyPath = path.join(dataDir, LEGACY_SESSION_FILE);
    if (!fsImpl.existsSync(legacyPath)) return;
    const index = readIndex();
    if (index.accounts.length === 0) {
      try {
        const session = parseSession(JSON.parse(decrypt(fsImpl.readFileSync(legacyPath))));
        writeIndex(upsert(index, session));
      } catch {
        return;
      }
    }
    try {
      fsImpl.rmSync(legacyPath, { force: true });
    } catch {
      return;
    }
  };

  carryLegacySession();

  const activeEntry = (index) => index.accounts.find((entry) => entry.userId === index.active) ?? null;

  const read = () => {
    const index = readIndex();
    return index.active ? readSessionOf(index.active) : null;
  };

  const write = (session, { activate = true } = {}) => {
    writeIndex(upsert(readIndex(), session, activate));
  };

  const signOut = (userId) => {
    const index = readIndex();
    const entry = index.accounts.find((candidate) => candidate.userId === userId);
    if (!entry) return;
    entry.signedIn = false;
    fsImpl.rmSync(sessionPath(userId), { force: true });
    if (index.active === userId) {
      index.active = index.accounts.find((candidate) => candidate.signedIn)?.userId ?? null;
    }
    writeIndex(index);
  };

  const clear = () => {
    const index = readIndex();
    if (index.active) signOut(index.active);
  };

  const activate = (userId) => {
    const index = readIndex();
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

  const activeHome = () => activeEntry(readIndex())?.home ?? null;

  return { read, write, clear, activate, signOut, list, activeHome };
}

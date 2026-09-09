import nodeFs from 'node:fs';
import path from 'node:path';

const asNonEmptyString = (value, field) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`Mittr session is missing ${field}`);
  return text;
};

/**
 * The only place a payload from Mittr becomes a session the rest of this process
 * trusts. Fields are copied by name, so anything the server adds later — or
 * anything an attacker manages to inject — does not travel any further than
 * here.
 */
export function parseSession(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Mittr session must be an object');
  }

  const expiresAt = payload.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw new Error('Mittr session is missing a numeric expiresAt');
  }

  const subject = payload.subject;
  if (!subject || typeof subject !== 'object') {
    throw new Error('Mittr session is missing subject');
  }

  return {
    accessToken: asNonEmptyString(payload.accessToken, 'accessToken'),
    refreshToken: asNonEmptyString(payload.refreshToken, 'refreshToken'),
    expiresAt,
    subject: {
      userId: asNonEmptyString(subject.userId, 'subject.userId'),
      // A missing display name costs a nicety in the UI, not a sign-in.
      displayName: typeof subject.displayName === 'string' ? subject.displayName : '',
    },
  };
}

/**
 * `encrypt`/`decrypt` come from the host — Electron's safeStorage on the
 * desktop — so the tokens are protected by the OS keychain rather than by file
 * permissions alone.
 */
export function createSessionStore({ filePath, encrypt, decrypt, fsImpl = nodeFs }) {
  const read = () => {
    let raw;
    try {
      raw = fsImpl.readFileSync(filePath);
    } catch {
      return null;
    }
    try {
      return parseSession(JSON.parse(decrypt(raw)));
    } catch {
      // Unreadable or malformed is not a crash: it is the same situation as
      // never having signed in, and signing in again costs one click.
      return null;
    }
  };

  const write = (session) => {
    // Parse before writing too, so a bad payload fails at the point it arrives
    // rather than on the next start, when nothing is left to explain it.
    const parsed = parseSession(session);
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(filePath, encrypt(JSON.stringify(parsed)), { mode: 0o600 });
    if (process.platform !== 'win32') fsImpl.chmodSync(filePath, 0o600);
  };

  const clear = () => {
    try {
      fsImpl.rmSync(filePath, { force: true });
    } catch {
      // Already gone.
    }
  };

  return { read, write, clear };
}

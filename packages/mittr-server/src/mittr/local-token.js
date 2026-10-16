import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TOKEN_PATTERN = /^mc_local_[0-9a-f]{64}$/;
const PRIVATE = 0o600;

const readToken = (tokenPath) => {
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    return TOKEN_PATTERN.test(existing) ? existing : null;
  } catch {
    return null;
  }
};

const writePrivate = (target, content) => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: PRIVATE });
    fs.chmodSync(temporary, PRIVATE);
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
};

/**
 * The key the engine presents to the shim. It opens only the shim, only from
 * this machine, and carries no authority at Mittr, so minting a new one is
 * always safe: the engine is handed whatever this returns.
 *
 * `rotate` mints a new key even when a valid one is on disk. The server does
 * that once per run, so a key that leaked out of an engine config (a
 * repository can point the provider's URL elsewhere) dies with the run.
 */
export function ensureLocalToken({ tokenPath, rotate = false }) {
  const existing = rotate ? null : readToken(tokenPath);
  if (existing) {
    if (process.platform !== 'win32' && (fs.statSync(tokenPath).mode & 0o777) !== PRIVATE) fs.chmodSync(tokenPath, PRIVATE);
    return existing;
  }
  const token = `mc_local_${crypto.randomBytes(32).toString('hex')}`;
  writePrivate(tokenPath, token);
  return token;
}

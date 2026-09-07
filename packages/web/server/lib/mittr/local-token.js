import nodeFs from 'node:fs';
import nodeCrypto from 'node:crypto';
import path from 'node:path';

const TOKEN_PATTERN = /^mc_local_[0-9a-f]{64}$/;

// This token authorises the engine to reach the server running beside it on the
// same machine. It carries no authority at Mittr, which is why regenerating it
// after corruption is safe: the engine is reconfigured from the same process
// that writes it.
export function ensureLocalToken({
  tokenPath,
  fsImpl = nodeFs,
  randomBytes = nodeCrypto.randomBytes,
}) {
  try {
    const existing = fsImpl.readFileSync(tokenPath, 'utf8').trim();
    if (TOKEN_PATTERN.test(existing)) return existing;
  } catch {
    // Missing or unreadable: fall through and mint a new one.
  }

  const token = `mc_local_${randomBytes(32).toString('hex')}`;
  fsImpl.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fsImpl.writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') fsImpl.chmodSync(tokenPath, 0o600);
  return token;
}

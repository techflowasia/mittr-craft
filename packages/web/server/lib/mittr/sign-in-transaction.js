import nodeCrypto from 'node:crypto';
import { deepLinkScheme } from './deep-link-scheme.js';

const TRANSACTION_TTL_MS = 10 * 60 * 1000;

const CALLBACK_HOST = 'auth';

/**
 * Starts a sign-in. Only the challenge leaves this process; the verifier stays
 * here and is what proves, at exchange time, that the code belongs to the
 * sign-in this machine started.
 */
export function createTransaction({
  randomBytes = nodeCrypto.randomBytes,
  now = Date.now,
} = {}) {
  const verifier = randomBytes(32).toString('hex');
  return {
    verifier,
    challenge: nodeCrypto.createHash('sha256').update(verifier).digest('base64url'),
    createdAt: now(),
  };
}

/**
 * Mittr does not echo a state parameter; it keeps an opaque one of its own and
 * returns only a code. A code minted against somebody else's challenge cannot be
 * redeemed with our verifier, so that binding — not a matching state — is what
 * protects the exchange.
 *
 * Requiring a pending transaction is also what keeps this a deliberate act: any
 * application on the machine can claim the URL scheme, and a callback that
 * arrives when nobody asked to sign in is refused rather than acted on.
 */
export function verifyCallback(transaction, callbackUrl, { now = Date.now, scheme = deepLinkScheme() } = {}) {
  if (!transaction) throw new Error('No sign-in is in progress');

  let url;
  try {
    url = new URL(String(callbackUrl));
  } catch {
    throw new Error('Sign-in callback is not a valid URL');
  }

  if (url.protocol !== `${scheme}:` || url.hostname !== CALLBACK_HOST) {
    throw new Error('Sign-in callback did not arrive on the auth deep link');
  }

  if (now() - transaction.createdAt > TRANSACTION_TTL_MS) {
    throw new Error('Sign-in transaction expired');
  }

  const code = (url.searchParams.get('code') ?? '').trim();
  if (!code) throw new Error('Sign-in callback carried no code');

  return { code };
}

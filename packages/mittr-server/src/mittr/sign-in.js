import nodeCrypto from 'node:crypto';

export const TRANSACTION_TTL_MS = 600_000;

const CALLBACK_HOST = 'auth';
const DEFAULT_SCHEME = 'mittrcraft';
const SCHEME = /^[a-z][a-z0-9+.-]{0,63}$/;

/** The app's own URL scheme: `mittrcraft-dev` for Dev, `mittrcraft` otherwise. */
export function deepLinkScheme(env = process.env) {
  const declared = String(env.MITTRCRAFT_DEEP_LINK_SCHEME ?? '').trim().toLowerCase();
  if (!declared) return DEFAULT_SCHEME;
  if (!SCHEME.test(declared)) throw new Error(`MITTRCRAFT_DEEP_LINK_SCHEME is not a valid URL scheme: ${declared}`);
  return declared;
}

export const authRedirectUri = (scheme) => `${scheme}://${CALLBACK_HOST}/callback`;

/**
 * Starts a sign-in. Only the challenge leaves this process; the verifier stays
 * here and is what proves, at exchange time, that the code belongs to the
 * sign-in this machine started.
 */
export function createTransaction({ randomBytes = nodeCrypto.randomBytes, now = Date.now } = {}) {
  const verifier = randomBytes(32).toString('hex');
  return {
    verifier,
    challenge: nodeCrypto.createHash('sha256').update(verifier).digest('base64url'),
    createdAt: now(),
  };
}

/**
 * Mittr does not echo a state parameter; it returns only a code. A code minted
 * against somebody else's challenge cannot be redeemed with our verifier, so
 * that binding, not a matching state, is what protects the exchange.
 *
 * Requiring a pending transaction keeps this a deliberate act: any application
 * on the machine can claim the URL scheme, and a callback that arrives when
 * nobody asked to sign in is refused rather than acted on.
 */
export function verifyCallback(transaction, callbackUrl, { now = Date.now, scheme = DEFAULT_SCHEME } = {}) {
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

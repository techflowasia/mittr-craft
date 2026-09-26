const DEFAULT_SCHEME = 'mittrcraft';
const SCHEME = /^[a-z][a-z0-9+.-]{0,63}$/;

export function deepLinkScheme(env = process.env) {
  const declared = String(env.MITTRCRAFT_DEEP_LINK_SCHEME ?? '').trim().toLowerCase();
  if (!declared) return DEFAULT_SCHEME;
  if (!SCHEME.test(declared)) throw new Error(`MITTRCRAFT_DEEP_LINK_SCHEME is not a valid URL scheme: ${declared}`);
  return declared;
}

export const authRedirectUri = (env = process.env) => `${deepLinkScheme(env)}://auth/callback`;

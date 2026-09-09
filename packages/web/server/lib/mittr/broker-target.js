const DEFAULT_BROKER_BASE_URL = 'https://api.mittr.asia';

/**
 * Decides which Mittr the application talks to.
 *
 * A packaged build carries its environment: the desktop shell passes the origin
 * it was built against, baked in at build time. Nothing a person can edit after
 * installation changes it, which is the point (spec §4.1) and also the safer
 * position — the origin named here is where a signed-in developer's Mittr
 * session is sent, so it must not be repointable by anything casual.
 *
 * The environment variable exists for runs that were never packaged: the CLI,
 * a development server, a test. It is ignored the moment a build has declared
 * its own target, so a packaged application cannot be steered elsewhere by an
 * environment somebody happened to export.
 */
export function resolveBrokerBaseUrl({ packaged, env = {} } = {}) {
  const chosen = String(packaged ?? '').trim()
    || String(env.MITTRCRAFT_BROKER_URL ?? '').trim()
    || DEFAULT_BROKER_BASE_URL;

  let parsed;
  try {
    parsed = new URL(chosen);
  } catch {
    throw new Error(`Mittr broker URL is not a valid URL: ${chosen}`);
  }

  // Loopback is allowed so the whole path can be exercised against a local
  // instance. Anywhere else must be https: this carries a session token.
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !isLoopback) {
    throw new Error(`Mittr broker URL must use https outside loopback: ${chosen}`);
  }

  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    // Every endpoint is resolved against this as an origin. A path here would
    // be silently dropped by `new URL('/desktop/catalog', base)`, so a build
    // pointed at a prefixed host would look configured and reach the wrong
    // place.
    throw new Error(`Mittr broker URL must be an origin with no path: ${chosen}`);
  }

  return parsed.origin;
}

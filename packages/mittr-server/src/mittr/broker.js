const DEFAULT_BROKER_URL = 'https://api.mittr.asia';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

const parseUrl = (value, name) => {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL: ${value}`);
  }
};

// Loopback is allowed so the whole path can run against a local stand-in.
// Anywhere else must be https: this carries a session token.
const assertHttpsOutsideLoopback = (parsed, name, value) => {
  if (parsed.protocol !== 'https:' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`${name} must use https outside loopback: ${value}`);
  }
};

/**
 * Which Mittr this process talks to, and where model calls go.
 *
 * The prod product sets `MITTRCRAFT_BROKER_URL` with override and
 * `MITTRCRAFT_BROKER_FIXED=1`, so an exported variable cannot repoint an
 * installed app: the origin is where a signed-in developer's session is sent.
 * The Dev product only defaults it, so a Dev run can point at a local stand-in.
 *
 * Model calls go to the broker's own `/v1`, the API that resolves the aliases
 * its catalog issues; `MITTRCRAFT_UPSTREAM_URL` moves them only while the
 * broker is not fixed.
 */
export function resolveBroker(env = process.env) {
  const fixed = String(env.MITTRCRAFT_BROKER_FIXED ?? '').trim() === '1';
  const chosen = String(env.MITTRCRAFT_BROKER_URL ?? '').trim() || DEFAULT_BROKER_URL;

  const parsed = parseUrl(chosen, 'Mittr broker URL');
  assertHttpsOutsideLoopback(parsed, 'Mittr broker URL', chosen);
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    // Every endpoint is resolved against this as an origin, so a path here
    // would be dropped silently and reach the wrong place.
    throw new Error(`Mittr broker URL must be an origin with no path: ${chosen}`);
  }
  const baseUrl = parsed.origin;

  const override = fixed ? '' : String(env.MITTRCRAFT_UPSTREAM_URL ?? '').trim();
  if (override) assertHttpsOutsideLoopback(parseUrl(override, 'MITTRCRAFT_UPSTREAM_URL'), 'MITTRCRAFT_UPSTREAM_URL', override);
  const upstreamV1 = (override || `${baseUrl}/v1`).replace(/\/+$/, '');

  return { baseUrl, upstreamV1, fixed };
}

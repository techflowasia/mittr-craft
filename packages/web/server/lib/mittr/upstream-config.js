const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

// Configuration is absent far more often than it is wrong, and a shim that
// starts without an upstream would fail later inside a request, where the
// message reaches a developer as an unexplained model error.
//
// There is no credential here on purpose. What authorises a call upstream is the
// signed-in developer's own session, which rotates; a static token in the
// environment would be a second way in that nobody rotates.
export function resolveUpstream(env = process.env) {
  const rawUrl = String(env.MITTRCRAFT_UPSTREAM_URL ?? '').trim();
  if (!rawUrl) throw new Error('MITTRCRAFT_UPSTREAM_URL is required');

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`MITTRCRAFT_UPSTREAM_URL is not a valid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== 'https:' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`MITTRCRAFT_UPSTREAM_URL must use https outside loopback: ${rawUrl}`);
  }

  return { baseUrl: rawUrl.replace(/\/+$/, '') };
}

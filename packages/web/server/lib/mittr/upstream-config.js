const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

// Configuration is absent far more often than it is wrong, and a shim that
// starts without an upstream would fail later inside a request, where the
// message reaches a developer as an unexplained model error.
//
// There is no credential here on purpose. What authorises a call upstream is the
// signed-in developer's own session, which rotates; a static token in the
// environment would be a second way in that nobody rotates.
export function resolveUpstream(env = process.env, { defaultBaseUrl = '', allowOverride = true } = {}) {
  // Completions live on the same host as the catalog that issues the alias: it
  // is the API that resolves an alias to the provider and model its grant
  // pinned. So the upstream is derived from the broker rather than configured
  // beside it, and the two can no longer disagree — a shim pointed at the raw
  // LLM gateway would be handed an alias nothing there can resolve.
  //
  // The override exists for pointing a development run at a local stand-in. A
  // packaged build passes allowOverride: false, because the origin here is
  // where a signed-in developer's session token is sent and an installed
  // application must not be repointable by an exported variable.
  const override = allowOverride ? String(env.MITTRCRAFT_UPSTREAM_URL ?? '').trim() : '';
  const rawUrl = override || String(defaultBaseUrl ?? '').trim();
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

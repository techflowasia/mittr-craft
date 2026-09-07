import { resolveUpstream } from './upstream-config.js';
import { assertLoopbackHost } from './loopback-guard.js';
import { ensureLocalToken } from './local-token.js';
import { registerMittrShimRoutes } from './shim-routes.js';

// Both guards run before a single route is mounted, so a misconfigured install
// fails at startup where somebody is watching, rather than inside the first
// request where it reaches a developer as an unexplained model error.
export function startMittrShim({ app, host, port, tokenPath, env = process.env }) {
  assertLoopbackHost(host);
  const upstream = resolveUpstream(env);
  const localToken = ensureLocalToken({ tokenPath });

  registerMittrShimRoutes(app, { upstream, localToken });

  return { localToken, baseUrl: `http://${host}:${port}/v1` };
}

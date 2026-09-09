import path from 'node:path';
import { resolveUpstream } from './upstream-config.js';
import { assertLoopbackHost } from './loopback-guard.js';
import { ensureLocalToken } from './local-token.js';
import { createSessionStore } from './session.js';
import { registerMittrAuthRoutes } from './auth-routes.js';
import { registerMittrShimRoutes } from './shim-routes.js';

/**
 * Used when the host offers no OS-backed secret storage — a standalone server or
 * CLI, as opposed to the desktop, where Electron's safeStorage is available.
 *
 * The refresh token then sits on disk readable by its owner and nothing more.
 * That is weaker than the desktop, and it is deliberate rather than accidental:
 * refusing to run without a keychain would take sign-in away from every
 * non-desktop surface. It warns once so the weakening is visible in the log
 * rather than only in this comment.
 */
export const createPlaintextSecretStore = () => {
  let warned = false;
  return {
    encrypt: (text) => {
      if (!warned) {
        warned = true;
        console.warn('[mittr] no OS secret storage on this host: the Mittr session is stored unencrypted, readable by this user');
      }
      return Buffer.from(text, 'utf8');
    },
    decrypt: (buffer) => Buffer.from(buffer).toString('utf8'),
  };
};

/**
 * Both guards run before a single route is mounted, so a misconfigured install
 * fails at startup where somebody is watching, rather than inside the first
 * request where it reaches a developer as an unexplained model error.
 */
export function startMittrShim({
  app,
  host,
  port,
  dataDir,
  brokerBaseUrl,
  secretStore = createPlaintextSecretStore(),
  env = process.env,
}) {
  assertLoopbackHost(host);
  const upstream = resolveUpstream(env);
  const localToken = ensureLocalToken({ tokenPath: path.join(dataDir, 'mittr-shim-token') });

  const sessionStore = createSessionStore({
    filePath: path.join(dataDir, 'mittr-session'),
    ...secretStore,
  });

  const { ensureFreshSession } = registerMittrAuthRoutes(app, {
    brokerBaseUrl,
    sessionStore,
    fetchImpl: (...args) => fetch(...args),
  });

  registerMittrShimRoutes(app, { upstream, localToken, ensureFreshSession });

  return { localToken, baseUrl: `http://${host}:${port}/v1` };
}

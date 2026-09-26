import path from 'node:path';
import { resolveUpstream } from './upstream-config.js';
import { assertLoopbackHost } from './loopback-guard.js';
import { ensureLocalToken } from './local-token.js';
import { createSessionStore } from './session.js';
import { registerMittrAuthRoutes } from './auth-routes.js';
import { registerMittrShimRoutes } from './shim-routes.js';
import { registerMittrCatalogRoutes } from './catalog-routes.js';
import { registerMittrAuditRoutes } from './audit-routes.js';
import { createCatalogCache } from './catalog-cache.js';
import { createEnablementStore } from './local-enablement.js';
import { reconcileMcp } from './mcp-reconciler.js';
import { resolveRepositoryIdentity } from './repository-identity.js';

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
  syncModels,
  // False in a packaged build, whose origin was decided when it was built.
  allowUpstreamOverride = true,
  secretStore = createPlaintextSecretStore(),
  env = process.env,
}) {
  assertLoopbackHost(host);
  const upstream = resolveUpstream(env, {
    defaultBaseUrl: `${String(brokerBaseUrl).replace(/\/+$/, '')}/v1`,
    allowOverride: allowUpstreamOverride,
  });
  const localToken = ensureLocalToken({ tokenPath: path.join(dataDir, 'mittr-shim-token') });

  const sessionStore = createSessionStore({
    filePath: path.join(dataDir, 'mittr-session'),
    ...secretStore,
  });

  // The catalog routes are registered after the auth routes but the sign-in
  // handler needs to reach them, so the sync is handed over through a holder
  // rather than by reordering registration and losing the guard ordering above.
  const catalog = { sync: null };

  const { ensureFreshSession } = registerMittrAuthRoutes(app, {
    brokerBaseUrl,
    sessionStore,
    fetchImpl: (...args) => fetch(...args),
    onSignIn: () => catalog.sync?.(),
  });

  registerMittrShimRoutes(app, { upstream, localToken, ensureFreshSession });

  const cache = createCatalogCache({ filePath: path.join(dataDir, 'mittr-catalog.json') });
  const enablement = createEnablementStore({ filePath: path.join(dataDir, 'mittr-enablement.json') });

  // The engine's MCP writers and the git service are both loaded on demand. The
  // shim starts on every boot; neither of these is needed until somebody signs
  // in, and the git service in particular is large.
  const load = (() => {
    const cached = new Map();
    return (specifier) => {
      if (!cached.has(specifier)) cached.set(specifier, import(specifier));
      return cached.get(specifier);
    };
  })();

  const { sync: syncCatalog } = registerMittrCatalogRoutes(app, {
    brokerBaseUrl,
    ensureFreshSession,
    cache,
    enablement,
    syncModels,
    reconcile: async (catalog) => {
      const mcpApi = await load('../opencode/mcp.js');
      // Organisation connectors are written at user scope, so they are not tied
      // to whichever directory happened to be open when the sync ran.
      reconcileMcp({ catalog, enablement, workingDirectory: null, mcpApi });
    },
  });

  registerMittrAuditRoutes(app, {
    brokerBaseUrl,
    ensureFreshSession,
    resolveRepository: async (directory) => {
      const { getRemoteUrl } = await load('../git/index.js');
      return resolveRepositoryIdentity(directory, { getRemoteUrl });
    },
  });

  catalog.sync = syncCatalog;

  /**
   * Brings the engine's provider config in line with the last catalog we hold,
   * before any network call is made.
   *
   * This runs even when the cache is empty, and that is the point. An install
   * upgraded from a build that registered a fixed model still carries it, and
   * that id resolves to nothing now — so a developer would see a model, pick
   * it, and be refused. Deriving the provider from the catalog alone, including
   * the case where the catalog is empty, is what clears it.
   */
  const applyCachedCatalog = async () => {
    const cached = cache.read();
    await syncModels(cached?.models?.configured ? cached.models.items : []);
  };

  return {
    localToken,
    baseUrl: `http://${host}:${port}/v1`,
    syncCatalog,
    applyCachedCatalog,
    ensureFreshSession,
    brokerBaseUrl,
  };
}

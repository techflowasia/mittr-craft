import path from 'node:path';

import { createAccountStore } from './account-store.js';
import { registerMittrAuthRoutes } from './auth-routes.js';
import { resolveBroker } from './broker.js';
import { catalogCachePath, createCatalogCache } from './catalog-cache.js';
import { registerMittrCatalogRoutes } from './catalog-routes.js';
import { ensureMittrCredential, forgetMittrCredential } from './engine-credential.js';
import { ensureLocalToken } from './local-token.js';
import { createMittrSettings } from './mittr-settings.js';
import { policiesFragment } from './policies.js';
import { loopbackProxyExemption, mittrProviderFragment, shimBaseUrl } from './provider-config.js';
import { chooseSecretStore } from './secret-store.js';
import { registerMittrShim } from './shim-routes.js';
import { deepLinkScheme } from './sign-in.js';

const SIGNED_IN_EVENT = 'mittrcraft:signed-in';
const SIGN_IN_FAILED_EVENT = 'mittrcraft:sign-in-failed';
const SHIM_TOKEN_FILE = 'mittr-shim-token';

const modelListOf = (items) => items.map(({ alias, label }) => ({ alias, label }));

// After the engine refused the key while models were being applied, one more
// try this much later, so the picker does not sit on models that answer 401
// until the engine happens to restart.
const CREDENTIAL_RETRY_MS = 5_000;

// With nobody signed in there is no roster to show, whatever a past account
// left on disk.
const NO_ACCOUNT_CATALOG = {
  read: () => null,
  write: () => {
    throw new Error('No Mittr account is active');
  },
};

/**
 * Mittr on the server: sign-in through the platform's desktop flow, the
 * account store, the session refresh, and the loopback shim the engine sends
 * its model calls to. On the desktop the shell's
 * `mittrcraft[-dev]://auth/callback` deep link finishes a sign-in the same
 * way the callback route does.
 *
 * Mittr reaches the engine as the `mittr` provider in the managed config,
 * pointed at the shim, with the shim's per-run key as its credential (R55:
 * the engine never holds the Mittr token). The same config carries the
 * provider lock from the very first build.
 *
 * The models come from the active account's Mittr catalog. Setup applies the
 * cached one at once and then syncs without waiting; a sign-in syncs; an
 * account change applies that account's cache, then syncs.
 *
 * Returns what the server plugin merges: an engine env, a config fragment and
 * a dispose that does no network I/O, so it can never hold up shutdown, plus
 * `applyModels(items)`, which sets the account's models.
 */
export function setupMittr(context, {
  env = process.env,
  fetchImpl = (...args) => fetch(...args),
  sharedHistoryExists = () => true,
  credentialRetryMs = CREDENTIAL_RETRY_MS,
} = {}) {
  const { app, express, dataDir, logger = console, host = null, server, opencode, mergeEngineConfig } = context;
  const broker = resolveBroker(env);
  const scheme = deepLinkScheme(env);
  const { encrypt, decrypt, refusal } = chooseSecretStore({ host, logger });
  const store = createAccountStore({ dataDir, encrypt, decrypt, logger, sharedHistoryExists });

  // One cache per account file, resolved on every use: an account switch
  // moves every reader and the next sync's write to the new account's file.
  const catalogCaches = new Map();
  const activeCatalogCache = () => {
    if (!store.list().some((account) => account.active)) return NO_ACCOUNT_CATALOG;
    const filePath = catalogCachePath(dataDir, store.activeHome());
    if (!catalogCaches.has(filePath)) catalogCaches.set(filePath, createCatalogCache({ filePath, logger }));
    return catalogCaches.get(filePath);
  };
  const cachedModels = () => activeCatalogCache().read()?.models?.items ?? [];

  // Both are defined below and first called once setup has returned.
  let shim = null;
  const syncCatalog = () => catalog.sync();

  const { ensureFreshSession, completeSignIn } = registerMittrAuthRoutes(app, {
    express,
    broker,
    store,
    scheme,
    fetchImpl,
    signInRefusal: refusal,
    onSignIn: () => {
      void syncCatalog();
    },
    // A sign-out or a switch ends every answer still streaming on the
    // account that was active, whether or not the engine restarts. The
    // account now active brings its own models.
    onAccountChange: async () => {
      shim?.abortInFlight();
      await onModels(cachedModels());
      void syncCatalog();
    },
    logger,
  });

  // A new key every run: one that leaked from an earlier run opens nothing.
  const localToken = ensureLocalToken({ tokenPath: path.join(dataDir, SHIM_TOKEN_FILE), rotate: true });
  shim = registerMittrShim(app, {
    upstreamV1: broker.upstreamV1,
    localToken,
    ensureFreshSession,
    // Never an empty list for a catalog that cannot be read: the shim then
    // says the list is unavailable instead of "you have no models".
    listModels: () => {
      const current = activeCatalogCache().read();
      if (!current) throw new Error('no Mittr catalog is cached for the active account');
      return modelListOf(current.models.items);
    },
    fetchImpl,
    logger,
    env,
  });

  const catalog = registerMittrCatalogRoutes(app, {
    broker,
    ensureFreshSession,
    cache: activeCatalogCache,
    onModels: (items) => onModels(items),
    fetchImpl,
    logger,
  });

  const unregisterDeepLink = host?.deepLinks?.register({
    host: 'auth',
    // Either way the window is brought forward and re-reads status, so a
    // sign-in that failed in the browser is shown, not only logged.
    handle: async (link) => {
      try {
        await completeSignIn(link.raw);
        return { emit: SIGNED_IN_EVENT };
      } catch (error) {
        logger.warn('[mittr] sign-in from the browser did not finish:', error?.message ?? error);
        return { emit: SIGN_IN_FAILED_EVENT };
      }
    },
  }) ?? null;

  const mittrSettings = createMittrSettings({ dataDir, logger });
  let models = [];

  // The port is unknown before listen and may be random, so the URL is built
  // on each write. Without it there is no provider, but the lock stays.
  // Until the first build there is no config to refresh: before it, the
  // server may still answer a refresh with no fragment from this plugin at
  // all, which would write a config without the lock. `pendingRendered` is
  // the list the latest build or refresh put in the config it is about to
  // write; the server writes the file only after asking, so it counts as
  // written only once that refresh has finished.
  let configBuilt = false;
  let pendingRendered = null;
  const managedConfig = async () => {
    const rendered = models;
    const settings = await mittrSettings.read();
    configBuilt = true;
    pendingRendered = JSON.stringify(rendered);
    return [
      server.port() === null ? {} : mittrProviderFragment({ shimBaseUrl: shimBaseUrl(server.port()), models: rendered }),
      policiesFragment(settings),
    ].reduce((merged, fragment) => mergeEngineConfig(merged, fragment), {});
  };

  // Never throws: it runs from the engine's ready listener, and a failure
  // waits for the next ready or the next model change. Before the engine's
  // first ready there is nobody to give the key to; that ready gives it.
  let engineStarted = false;
  const storeCredential = async () => {
    if (models.length === 0 || !engineStarted) return 'skipped';
    try {
      const outcome = await ensureMittrCredential({ opencode, key: localToken, fetchImpl });
      if (outcome === 'stored') logger.log('[mittr] the engine has its Mittr key for this run');
      return outcome;
    } catch (error) {
      logger.warn('[mittr] could not give the engine its Mittr key; trying again later:', error?.message ?? error);
      return 'failed';
    }
  };

  // One more try, once: an engine that keeps refusing waits for its next ready.
  let credentialRetry = null;
  let disposed = false;
  const retryCredentialOnce = () => {
    if (credentialRetry || disposed) return;
    credentialRetry = setTimeout(() => {
      credentialRetry = null;
      void storeCredential();
    }, credentialRetryMs);
    credentialRetry.unref?.();
  };

  // Each ready is a new engine, maybe on the same port and another account's
  // database, and the key is new each run, so it is stored again.
  const unsubscribeReady = opencode.onReady(() => {
    engineStarted = true;
    forgetMittrCredential(opencode);
    void storeCredential();
  });

  // One list at a time: the server's refresh reads the models late and is not
  // serialised, so two overlapping applies could leave the config on the
  // older list. The config is rewritten only when the file is known to carry
  // another list, since the engine reloads on every write. Known means a
  // refresh finished: one that rendered and then failed to write leaves
  // `writtenModels` as it was, so the next apply writes again. The first
  // build's write is not reported back, so the first apply after it writes
  // once more.
  let applying = Promise.resolve();
  let writtenModels = null;
  const writeModels = async (items) => {
    models = modelListOf(items);
    if (!configBuilt || JSON.stringify(models) === writtenModels) return;
    await context.managedConfig.refresh();
    writtenModels = pendingRendered;
  };
  const applyModels = async (items) => {
    const written = applying.then(() => writeModels(items));
    applying = written.catch(() => {});
    await written;
    // Outside the chain on purpose: the key does not depend on the list, two
    // stores that overlap both converge on this run's key (one that loses a
    // race fails and is retried), and a slow one, which waits out the
    // engine's 404s, must not hold up the next list.
    if (await storeCredential() === 'failed') retryCredentialOnce();
  };

  // Sets the engine's models; a failure is logged and waits for the next
  // sync or start, never thrown into a route or the server.
  const onModels = async (items) => {
    try {
      await applyModels(items);
    } catch (error) {
      logger.warn('[mittr] could not apply the Mittr models:', error?.message ?? error);
    }
  };

  // The last list first, so an offline start still shows the account's
  // models; then the platform's current one, without holding up the start.
  // The engine's first config build reads these.
  models = modelListOf(cachedModels());
  void syncCatalog();

  return {
    engineEnv: () => loopbackProxyExemption(env),
    managedConfig,
    applyModels,
    dispose: async () => {
      disposed = true;
      clearTimeout(credentialRetry);
      credentialRetry = null;
      unsubscribeReady();
      unregisterDeepLink?.();
    },
  };
}

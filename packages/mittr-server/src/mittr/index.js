import fs from 'node:fs';
import path from 'node:path';

import { createAccountStore } from './account-store.js';
import { registerMittrAuthRoutes } from './auth-routes.js';
import { resolveBroker } from './broker.js';
import { catalogCachePath, createCatalogCache } from './catalog-cache.js';
import { registerMittrCatalogRoutes } from './catalog-routes.js';
import { syncDefaultModel } from './default-model.js';
import { ensureMittrCredential, forgetMittrCredential } from './engine-credential.js';
import { identityFragment, identityPluginDir, materializeIdentityPlugin } from './identity.js';
import { ensureLocalToken } from './local-token.js';
import { createMittrSettings } from './mittr-settings.js';
import { MITTR_PROVIDER_ID, policiesFragment } from './policies.js';
import { loopbackProxyExemption, mittrProviderFragment, shimBaseUrl } from './provider-config.js';
import { registerProviderLockRoutes } from './provider-lock-routes.js';
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
 * The lock follows the person's provider switch (R37/R40), off by default
 * and kept in `mittr-settings.json`; changing it rewrites the managed config.
 *
 * The models come from the active account's Mittr catalog. Setup applies the
 * cached one at once and then syncs without waiting; a sign-in syncs; an
 * account change applies that account's cache, then syncs.
 *
 * The same config loads the identity plugin, so the model calls itself
 * MittrCraft, never the engine's own name.
 *
 * The engine's default model follows the same lists, in the user's OpenCode
 * config, once the models are in the engine config: a fresh install starts on
 * the first Mittr agent, and no Mittr default is left without Mittr models.
 * It is written only when that config is the file the engine reads
 * (`engineConfigDir`).
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
  engineConfigDir = null,
} = {}) {
  const { app, express, dataDir, logger = console, host = null, server, opencode, mergeEngineConfig, events } = context;
  const broker = resolveBroker(env);
  const scheme = deepLinkScheme(env);
  const { encrypt, decrypt, refusal } = chooseSecretStore({ host, logger });
  const store = createAccountStore({ dataDir, encrypt, decrypt, logger, sharedHistoryExists });

  // One cache per account file, resolved on every use: an account switch
  // moves every reader and the next sync's write to the new account's file.
  const catalogCaches = new Map();
  // These read the account index only: opening a stored session may raise a
  // keychain dialog, which no lookup made while the app starts may do.
  const signedIn = () => store.list({ carryLegacy: false }).some((account) => account.active);
  const activeCatalogCache = () => {
    if (!signedIn()) return NO_ACCOUNT_CATALOG;
    const filePath = catalogCachePath(dataDir, store.activeHome({ carryLegacy: false }));
    if (!catalogCaches.has(filePath)) catalogCaches.set(filePath, createCatalogCache({ filePath, logger }));
    return catalogCaches.get(filePath);
  };
  // `known` is false for an account whose catalog has not arrived yet: its
  // models are none for now, but that says nothing about which it will have.
  const activeModelList = () => {
    if (!signedIn()) return { items: [], known: true };
    const cached = activeCatalogCache().read();
    return { items: cached?.models?.items ?? [], known: cached?.models?.configured === true };
  };

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
      const { items, known } = activeModelList();
      await onModels(items, { listKnown: known });
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
    onModels: (items) => onModels(items, { listKnown: true }),
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

  // The engine introduces itself as MittrCraft through a plugin written on
  // every build, before the config names it. When it cannot be written, a
  // plugin an earlier build left stays listed, so a failed write never drops
  // the name; with none on disk the name is all that is lost: the lock and
  // the models still go out, and the next build tries again.
  const identityConfig = async () => {
    try {
      return identityFragment(await materializeIdentityPlugin({ dataDir }));
    } catch (error) {
      const dir = identityPluginDir(dataDir);
      if (fs.existsSync(path.join(dir, 'index.js'))) {
        logger.warn('[mittr] could not rewrite the identity plugin; keeping the one already written:', error?.message ?? error);
        return identityFragment(dir);
      }
      logger.warn('[mittr] could not write the identity plugin; trying again on the next config write:', error?.message ?? error);
      return {};
    }
  };

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
    const identity = await identityConfig();
    configBuilt = true;
    pendingRendered = JSON.stringify(rendered);
    return [
      identity,
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
  // The first ready also starts the catalog sync that follows the last list:
  // it reads the stored session, and opening that can raise a keychain
  // dialog, so it waits until the server is listening and the window has
  // something to show.
  let startupSyncDone = false;
  const unsubscribeReady = opencode.onReady(() => {
    engineStarted = true;
    if (!startupSyncDone) {
      startupSyncDone = true;
      void syncCatalog();
    }
    forgetMittrCredential(opencode);
    void storeCredential();
  });

  // Only when the server's user config is the engine's: elsewhere it may be
  // a personal OpenCode config, which is never ours to write.
  const userConfig = opencode.userConfig ?? null;
  const ownsEngineUserConfig = Boolean(engineConfigDir && userConfig)
    && path.resolve(userConfig.path) === path.join(path.resolve(engineConfigDir), 'opencode.json');
  if (engineConfigDir && userConfig && !ownsEngineUserConfig) {
    logger.warn(`[mittr] the engine reads its config from ${path.resolve(engineConfigDir)}, not ${path.dirname(path.resolve(userConfig.path))}; the default model is left alone`);
  }
  // Never throws: a default that cannot be set leaves the models applied.
  const followDefaultModel = (items) => {
    if (!ownsEngineUserConfig) return;
    try {
      const modelIds = items.map((item) => item.alias);
      if (syncDefaultModel({ userConfig, providerId: MITTR_PROVIDER_ID, modelIds })) {
        logger.log(modelIds.length > 0 ? '[mittr] new sessions start on a Mittr agent' : '[mittr] no Mittr agent to start new sessions on');
      }
    } catch (error) {
      logger.warn('[mittr] could not set the default model:', error?.message ?? error);
    }
  };

  // One list at a time: the server's refresh reads the models late and is not
  // serialised, so two overlapping applies could leave the config on the
  // older list. The config is rewritten only when the file is known to carry
  // another list, since the engine reloads on every write. Known means a
  // refresh finished: one that rendered and then failed to write leaves
  // `writtenModels` as it was, so the next apply writes again. The first
  // build's write is not reported back, so the first apply after it writes
  // once more. The default model moves only after its list is in the engine
  // config (or, before the first build, will be in it at the engine's start),
  // and only for a list that is known.
  let applying = Promise.resolve();
  let writtenModels = null;
  const writeModels = async (items, listKnown) => {
    models = modelListOf(items);
    if (configBuilt && JSON.stringify(models) !== writtenModels) {
      await context.managedConfig.refresh();
      writtenModels = pendingRendered;
    }
    if (listKnown) followDefaultModel(models);
  };
  const applyModels = async (items, { listKnown = true } = {}) => {
    const written = applying.then(() => writeModels(items, listKnown));
    applying = written.catch(() => {});
    await written;
    // Outside the chain on purpose: the key does not depend on the list, two
    // stores that overlap both converge on this run's key (one that loses a
    // race fails and is retried), and a slow one, which waits out the
    // engine's 404s, must not hold up the next list.
    if (await storeCredential() === 'failed') retryCredentialOnce();
  };

  // The provider switch goes through the same queue: its write renders the
  // current list too, so it counts as that list written, and a list being
  // written is never overtaken by a config rendered before it. Before the
  // first build there is nothing to rewrite; the build reads the stored switch.
  const rewriteProviderLock = () => {
    const written = applying.then(async () => {
      if (!configBuilt) return;
      await context.managedConfig.refresh();
      writtenModels = pendingRendered;
    });
    applying = written.catch(() => {});
    return written;
  };
  registerProviderLockRoutes(app, {
    express,
    mittrSettings,
    managedConfig: { refresh: rewriteProviderLock },
    events,
    logger,
  });

  // Sets the engine's models; a failure is logged and waits for the next
  // sync or start, never thrown into a route or the server.
  const onModels = async (items, options) => {
    try {
      await applyModels(items, options);
    } catch (error) {
      logger.warn('[mittr] could not apply the Mittr models:', error?.message ?? error);
    }
  };

  // The last list first, so an offline start still shows the account's
  // models; the platform's current one follows the engine's first ready,
  // without holding up the start. The engine's first config build reads
  // these, and its start the default.
  const startList = activeModelList();
  models = modelListOf(startList.items);
  if (startList.known) followDefaultModel(models);

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

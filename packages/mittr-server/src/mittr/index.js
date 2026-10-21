import fs from 'node:fs';
import path from 'node:path';

import { ENGINE_SHARE_OFF } from '../engine-outbound.js';
import { createAccountStore, keyOf } from './account-store.js';
import { createAccountSwitcher } from './accounts-switch.js';
import { createAnsweredByLog, createAnsweredByWatcher, registerAnsweredByRoute } from './answered-by.js';
import { registerMittrAuditRoutes } from './audit-routes.js';
import { registerMittrAuthRoutes } from './auth-routes.js';
import { resolveBroker } from './broker.js';
import { catalogCachePath, createCatalogCache } from './catalog-cache.js';
import { registerMittrCatalogRoutes } from './catalog-routes.js';
import { syncDefaultModel } from './default-model.js';
import { createEnablementStore } from './enablement.js';
import { ensureMittrCredential, forgetMittrCredential } from './engine-credential.js';
import { identityFragment, identityPluginDir, materializeIdentityPlugin } from './identity.js';
import { registerMittrIntegrationsRoutes } from './integrations-routes.js';
import { mintLocalToken } from './local-token.js';
import { catalogMcpServers, heldMcpNames, mcpFragment, sweepLegacyUserMcp } from './mcp-fragment.js';
import { createMittrSettings } from './mittr-settings.js';
import { createModelRefusalHandler, createThrottle } from './model-refusal.js';
import { MITTR_PROVIDER_ID, policiesFragment } from './policies.js';
import { loopbackProxyExemption, mittrProviderFragment, shimBaseUrl } from './provider-config.js';
import { registerProviderLockRoutes } from './provider-lock-routes.js';
import { mittrQuotaProvider } from './quota-provider.js';
import { registerMittrQuotaRoutes } from './quota-routes.js';
import { createMittrQuotaService } from './quota-service.js';
import { chooseSecretStore } from './secret-store.js';
import { registerMittrShim } from './shim-routes.js';
import { deepLinkScheme } from './sign-in.js';
import { reconcileSkills, skillIdOf } from './skill-reconciler.js';
import { registerMittrWorkRoutes } from './work-routes.js';

const SIGNED_IN_EVENT = 'mittrcraft:signed-in';
const SIGN_IN_FAILED_EVENT = 'mittrcraft:sign-in-failed';
const RESYNC_INTERVAL_MS = 60_000;
const MANAGED_CONFIG_FILE_NAME = 'opencode.managed.json';
const QUIET_LOGGER = { warn: () => {} };
const HOSTED_CONNECTORS_OFF = '[mittr] catalog connectors are off on hosted web until an administrator decides how their secrets are protected';

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
 * cached one at once; the engine's first ready syncs it without waiting (the
 * stored session is not opened while the app starts); a sign-in syncs; an
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
  engineDataHome = null,
  now = Date.now,
  mintShimKey = mintLocalToken,
  companySignIn = false,
} = {}) {
  const { app, express, dataDir, logger = console, host = null, server, opencode, mergeEngineConfig, events, git, uiAuth } = context;
  const connectorsOff = !host || companySignIn === true || uiAuth?.passwordEnabled?.() === true;
  if (connectorsOff) logger.log(HOSTED_CONNECTORS_OFF);
  const broker = resolveBroker(env);
  const scheme = deepLinkScheme(env);
  const { encrypt, decrypt, refusal } = chooseSecretStore({ host, logger });
  // A 1.x single session is carried on the first read, not at setup. Until
  // then it counts as the signed-in account (see `activeModelList`); once it
  // is a real account the cache is applied again.
  const store = createAccountStore({
    dataDir,
    encrypt,
    decrypt,
    logger,
    sharedHistoryExists,
    onLegacyCarried: () => {
      applySkillsQuietly();
      sweepLegacyConnectorsQuietly();
      const { items, known } = activeModelList();
      void onModels(items, { listKnown: known });
    },
    onLegacyCarryFailed: () => correctEngineHomeSoon(),
  });

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
    const items = cached?.models?.items ?? [];
    // A 1.x session not yet carried may be anybody's: an empty list says
    // nothing about what it will offer, and must not take the default away.
    const known = cached?.models?.configured === true && !(items.length === 0 && store.legacyPending());
    return { items, known };
  };

  const activeCatalogModels = () => activeCatalogCache().read()?.models ?? null;

  const enablement = createEnablementStore({ filePath: path.join(dataDir, 'mittr-enablement.json') });
  const skillsRoot = engineConfigDir ? path.join(engineConfigDir, 'skills') : null;
  const activeAccountKey = () => {
    const active = store.list({ carryLegacy: false }).find((account) => account.active);
    return active?.userId ? keyOf(active.userId) : null;
  };
  const applySkills = (catalog = activeCatalogCache().read()) => {
    const result = reconcileSkills({ catalog, enablement, skillsRoot, accountKey: activeAccountKey() });
    for (const failure of result.failed) logger.warn(`[mittr] catalog skill '${failure.name}' was not applied: ${failure.error}`);
    return result;
  };
  const applySkillsQuietly = (catalog) => {
    try {
      applySkills(catalog);
    } catch (error) {
      logger.warn('[mittr] could not apply the catalog skills:', error?.message ?? error);
    }
  };
  const applySkillsAfterToggle = (name) => {
    const { failed } = applySkills();
    if (failed.some((failure) => failure.name === skillIdOf(name))) throw new Error(`catalog skill '${skillIdOf(name)}' was not applied`);
  };

  // Only when the server's user config is the engine's: elsewhere it may be
  // a personal OpenCode config, which is never ours to write.
  const userConfig = opencode.userConfig ?? null;
  const ownsEngineUserConfig = Boolean(engineConfigDir && userConfig)
    && path.resolve(userConfig.path) === path.join(path.resolve(engineConfigDir), 'opencode.json');
  if (engineConfigDir && userConfig && !ownsEngineUserConfig) {
    logger.warn(`[mittr] the engine reads its config from ${path.resolve(engineConfigDir)}, not ${path.dirname(path.resolve(userConfig.path))}; the default model is left alone`);
  }
  const sweepLegacyConnectorsQuietly = () => {
    if (!ownsEngineUserConfig) return;
    try {
      const swept = sweepLegacyUserMcp(userConfig);
      if (swept.length > 0) logger.log(`[mittr] removed 1.22 catalog connector entries from the user config: ${swept.join(', ')}`);
    } catch (error) {
      logger.warn('[mittr] could not clear the 1.22 catalog connectors from the user config:', error?.message ?? error);
    }
  };
  const readText = (filePath) => {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  };
  const readUserConfigQuietly = () => {
    try {
      return userConfig ? [userConfig.read()] : [];
    } catch {
      return [];
    }
  };
  const managedFile = path.resolve(dataDir, MANAGED_CONFIG_FILE_NAME);
  const ownEngineConfigTexts = () => {
    const file = String(env.OPENCODE_CONFIG ?? '').trim();
    const content = String(env.OPENCODE_CONFIG_CONTENT ?? '');
    return [file && path.resolve(file) !== managedFile ? readText(path.resolve(file)) : null, content.trim() ? content : null];
  };
  const ownMcpNames = () => {
    const dirs = new Set([engineConfigDir, userConfig ? path.dirname(userConfig.path) : null].filter(Boolean).map((dir) => path.resolve(dir)));
    const texts = [
      ...[...dirs].flatMap((dir) => ['opencode.json', 'opencode.jsonc'].map((name) => readText(path.join(dir, name)))),
      ...ownEngineConfigTexts(),
    ].filter((text) => text !== null);
    return heldMcpNames({ configs: readUserConfigQuietly(), texts });
  };
  const connectorInputs = () => ({ collection: activeCatalogCache().read()?.mcp, enablement, toEntity: opencode.mcpEntity, held: ownMcpNames() });
  const managedConnectors = ({ log = false } = {}) => {
    if (connectorsOff || activeAccountKey() === null) return {};
    try {
      return mcpFragment({ ...connectorInputs(), logger: log ? logger : QUIET_LOGGER });
    } catch (error) {
      if (log) logger.warn('[mittr] could not render the catalog connectors:', error?.message ?? error);
      return {};
    }
  };
  const connectorLeftOut = (name) => {
    if (connectorsOff || activeAccountKey() === null) return false;
    return catalogMcpServers(connectorInputs()).leftOut.some((entry) => entry.name === name);
  };

  const answeredByLog = createAnsweredByLog({ perSession: 10, sessions: 100 });

  // Both are defined below and first called once setup has returned.
  let shim = null;
  let audit = null;
  const syncCatalog = () => catalog.sync();
  let accountSync = null;
  const syncAfterAccountChange = () => {
    const outcome = syncCatalog();
    accountSync = { key: activeAccountKey(), outcome };
    return outcome;
  };
  const onRefusal = createModelRefusalHandler({
    mayResync: createThrottle(RESYNC_INTERVAL_MS, now),
    syncStored: () => catalog.syncStored(),
    catalogModels: activeCatalogModels,
  });

  const switcher = createAccountSwitcher({
    store,
    opencode,
    applyCache: () => {
      applySkillsQuietly();
      sweepLegacyConnectorsQuietly();
      const { items, known } = activeModelList();
      return onModels(items, { listKnown: known });
    },
    sync: syncAfterAccountChange,
    engineDataHome,
    logger,
  });

  let disposed = false;
  let correction = null;
  const correctEngineHomeSoon = () => {
    if (switcher.engineOnTarget() || correction || disposed) return;
    correction = setTimeout(() => {
      correction = null;
      void switcher.correctEngineHome();
    }, 0);
    correction.unref?.();
  };

  const { ensureFreshSession, completeSignIn } = registerMittrAuthRoutes(app, {
    express,
    broker,
    store,
    scheme,
    fetchImpl,
    signInRefusal: refusal,
    onSignIn: () => switcher.afterSignIn(),
    // A sign-out or a switch ends every answer still streaming on the
    // account that was active, whether or not the engine restarts. The
    // account now active brings its own models.
    onAccountChange: (nextUserId) => {
      shim?.abortInFlight();
      answeredByLog.clear();
      audit?.clear();
      return switcher.switchTo(nextUserId);
    },
    switchSettled: () => switcher.settledOnTarget(),
    logger,
  });

  // A new key every run: one that leaked from an earlier run opens nothing.
  const localToken = mintShimKey();
  shim = registerMittrShim(app, {
    upstreamV1: broker.upstreamV1,
    localToken,
    ensureFreshSession,
    engineOnActiveHome: () => !signedIn() || switcher.engineOnTarget(),
    // Never an empty list for a catalog that cannot be read: the shim then
    // says the list is unavailable instead of "you have no models".
    listModels: () => {
      const current = activeCatalogCache().read();
      if (!current) throw new Error('no Mittr catalog is cached for the active account');
      return modelListOf(current.models.items);
    },
    onAnswer: createAnsweredByWatcher(answeredByLog.record),
    onRefusal,
    fetchImpl,
    logger,
    env,
  });
  registerAnsweredByRoute(app, { log: answeredByLog });

  const catalog = registerMittrCatalogRoutes(app, {
    express,
    broker,
    ensureFreshSession,
    cache: activeCatalogCache,
    enablement,
    onModels: (items) => onModels(items, { listKnown: true }),
    onCatalog: async (stored) => {
      applySkillsQuietly(stored);
      sweepLegacyConnectorsQuietly();
      await rewriteIfChanged();
    },
    onEnablementChange: async (kind, name) => {
      if (kind === 'skills') applySkillsAfterToggle(name);
      if (kind === 'mcp') await applyConnectorsAfterToggle(name);
    },
    fetchImpl,
    logger,
  });

  audit = registerMittrAuditRoutes(app, {
    express,
    broker,
    ensureFreshSession,
    activeUserId: () => store.list({ carryLegacy: false }).find((account) => account.active)?.userId ?? null,
    git,
    fetchImpl,
    logger,
  });

  const quotaService = createMittrQuotaService({ broker, ensureFreshSession, fetchImpl });
  registerMittrQuotaRoutes(app, { service: quotaService });
  registerMittrWorkRoutes(app, { broker, ensureFreshSession, fetchImpl, logger });
  registerMittrIntegrationsRoutes(app, { express, broker, ensureFreshSession, fetchImpl, logger });
  const unregisterDeepLink = host?.deepLinks?.register({
    host: 'auth',
    // Either way the window is brought forward and re-reads status, so a
    // sign-in that failed in the browser is shown, not only logged.
    handle: async (link) => {
      try {
        await completeSignIn(link.raw);
        return { emit: SIGNED_IN_EVENT };
      } catch (error) {
        if (error?.stale) {
          logger.warn('[mittr] a sign-in from the browser arrived for a cancelled attempt and was dropped:', error.message);
          return {};
        }
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
  const fingerprintOf = (renderedModels, connectors) => JSON.stringify([renderedModels, connectors]);
  const managedConfig = async () => {
    const rendered = models;
    const connectors = managedConnectors({ log: true });
    const settings = await mittrSettings.read();
    const identity = await identityConfig();
    configBuilt = true;
    pendingRendered = fingerprintOf(rendered, connectors);
    return [
      identity,
      server.port() === null ? {} : mittrProviderFragment({ shimBaseUrl: shimBaseUrl(server.port()), models: rendered }),
      connectors,
      ENGINE_SHARE_OFF,
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
  // It counts as done once it succeeds or finds nobody signed in, so a later
  // ready retries a first sync that found the platform unreachable.
  let startupSyncDone = false;
  let startupSyncRunning = false;
  const startupSync = async () => {
    if (startupSyncDone || startupSyncRunning) return;
    startupSyncRunning = true;
    try {
      const covering = accountSync?.key === activeAccountKey() ? await accountSync.outcome : null;
      const outcome = covering?.status === 200 ? covering : await syncCatalog();
      if (outcome?.status === 200 || (outcome?.status === 401 && !signedIn())) startupSyncDone = true;
    } finally {
      startupSyncRunning = false;
    }
  };
  const unsubscribeReady = opencode.onReady(() => {
    engineStarted = true;
    correctEngineHomeSoon();
    void startupSync();
    forgetMittrCredential(opencode);
    void storeCredential();
  });

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
    if (configBuilt && fingerprintOf(models, managedConnectors()) !== writtenModels) {
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
  const rewriteIfChanged = () => {
    const written = applying.then(async () => {
      if (!configBuilt || fingerprintOf(models, managedConnectors()) === writtenModels) return;
      await context.managedConfig.refresh();
      writtenModels = pendingRendered;
    });
    applying = written.catch(() => {});
    return written;
  };
  const applyConnectorsAfterToggle = async (name) => {
    sweepLegacyConnectorsQuietly();
    if (connectorsOff) return;
    await rewriteProviderLock();
    if (connectorLeftOut(name)) throw new Error(`catalog connector '${name}' was not applied`);
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
      return true;
    } catch (error) {
      logger.warn('[mittr] could not apply the Mittr models:', error?.message ?? error);
      return false;
    }
  };

  // The last list first, so an offline start still shows the account's
  // models; the platform's current one follows the engine's first ready,
  // without holding up the start. The engine's first config build reads
  // these, and its start the default.
  applySkillsQuietly();
  sweepLegacyConnectorsQuietly();
  const startList = activeModelList();
  models = modelListOf(startList.items);
  if (startList.known) followDefaultModel(models);

  let unregisterQuotaProvider = null;
  try {
    unregisterQuotaProvider = context.registerQuotaProvider(mittrQuotaProvider({
      service: quotaService,
      isSignedIn: signedIn,
      isBrokerConfigured: () => Boolean(broker.baseUrl),
      catalogModels: activeCatalogModels,
      ...context.quotaResult,
    }), { exclusive: true });
  } catch (error) {
    logger.warn('[mittr] could not add Mittr to the usage providers:', error?.message ?? error);
  }

  return {
    engineEnv: () => loopbackProxyExemption(env),
    engineHome: () => store.engineHome({ carryLegacy: false }),
    managedConfig,
    applyModels,
    dispose: async () => {
      disposed = true;
      clearTimeout(credentialRetry);
      credentialRetry = null;
      clearTimeout(correction);
      correction = null;
      unsubscribeReady();
      unregisterDeepLink?.();
      unregisterQuotaProvider?.();
    },
  };
}

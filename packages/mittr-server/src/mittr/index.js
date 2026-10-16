import path from 'node:path';

import { createAccountStore } from './account-store.js';
import { registerMittrAuthRoutes } from './auth-routes.js';
import { resolveBroker } from './broker.js';
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
 * Returns what the server plugin merges: an engine env, a config fragment and
 * a dispose that does no network I/O, so it can never hold up shutdown, plus
 * `applyModels(items)`, which sets the account's models.
 */
export function setupMittr(context, { env = process.env, fetchImpl = (...args) => fetch(...args), sharedHistoryExists = () => true } = {}) {
  const { app, express, dataDir, logger = console, host = null, server, opencode, mergeEngineConfig } = context;
  const broker = resolveBroker(env);
  const scheme = deepLinkScheme(env);
  const { encrypt, decrypt, refusal } = chooseSecretStore({ host, logger });
  const store = createAccountStore({ dataDir, encrypt, decrypt, logger, sharedHistoryExists });

  let shim = null;
  const { ensureFreshSession, completeSignIn } = registerMittrAuthRoutes(app, {
    express,
    broker,
    store,
    scheme,
    fetchImpl,
    signInRefusal: refusal,
    // A sign-out or a switch ends every answer still streaming on the
    // account that was active, whether or not the engine restarts.
    onAccountChange: () => {
      shim?.abortInFlight();
    },
    logger,
  });

  // A new key every run: one that leaked from an earlier run opens nothing.
  const localToken = ensureLocalToken({ tokenPath: path.join(dataDir, SHIM_TOKEN_FILE), rotate: true });
  shim = registerMittrShim(app, {
    upstreamV1: broker.upstreamV1,
    localToken,
    ensureFreshSession,
    fetchImpl,
    logger,
    env,
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
  const providerFragment = () => {
    const port = server.port();
    return port === null ? {} : mittrProviderFragment({ shimBaseUrl: shimBaseUrl(port), models });
  };
  const managedConfig = async () =>
    [providerFragment(), policiesFragment(await mittrSettings.read())].reduce((merged, fragment) => mergeEngineConfig(merged, fragment), {});

  // Never throws: it runs from the engine's ready listener, and a failure
  // waits for the next ready or the next model change. Before the engine's
  // first ready there is nobody to give the key to; that ready gives it.
  let engineStarted = false;
  const storeCredential = async () => {
    if (models.length === 0 || !engineStarted) return;
    try {
      if (await ensureMittrCredential({ opencode, key: localToken, fetchImpl }) === 'stored') {
        logger.log('[mittr] the engine has its Mittr key for this run');
      }
    } catch (error) {
      logger.warn('[mittr] could not give the engine its Mittr key; trying again when it is next ready:', error?.message ?? error);
    }
  };

  // Each ready is a new engine, maybe on the same port and another account's
  // database, and the key is new each run, so it is stored again.
  const unsubscribeReady = opencode.onReady(() => {
    engineStarted = true;
    forgetMittrCredential(opencode);
    void storeCredential();
  });

  const applyModels = async (items) => {
    models = items.map(({ alias, label }) => ({ alias, label }));
    await context.managedConfig.refresh();
    await storeCredential();
  };

  return {
    engineEnv: () => loopbackProxyExemption(env),
    managedConfig,
    applyModels,
    dispose: async () => {
      unsubscribeReady();
      unregisterDeepLink?.();
    },
  };
}

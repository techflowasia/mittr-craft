import path from 'node:path';

import { createAccountStore } from './account-store.js';
import { registerMittrAuthRoutes } from './auth-routes.js';
import { resolveBroker } from './broker.js';
import { ensureLocalToken } from './local-token.js';
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
 * Returns what the server plugin merges: an engine env, a config fragment and
 * a dispose that does no network I/O, so it can never hold up shutdown.
 */
export function setupMittr(context, { env = process.env, fetchImpl = (...args) => fetch(...args), sharedHistoryExists = () => true } = {}) {
  const { app, express, dataDir, logger = console, host = null } = context;
  const broker = resolveBroker(env);
  const scheme = deepLinkScheme(env);
  const { encrypt, decrypt, refusal } = chooseSecretStore({ host, logger });
  const store = createAccountStore({ dataDir, encrypt, decrypt, logger, sharedHistoryExists });

  const { ensureFreshSession, completeSignIn } = registerMittrAuthRoutes(app, {
    express,
    broker,
    store,
    scheme,
    fetchImpl,
    signInRefusal: refusal,
    logger,
  });

  // A new key every run: one that leaked from an earlier run opens nothing.
  const localToken = ensureLocalToken({ tokenPath: path.join(dataDir, SHIM_TOKEN_FILE), rotate: true });
  registerMittrShim(app, {
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

  return {
    engineEnv: () => ({}),
    managedConfig: () => ({}),
    dispose: async () => {
      unregisterDeepLink?.();
    },
  };
}

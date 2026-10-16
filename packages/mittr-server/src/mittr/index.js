import { createAccountStore } from './account-store.js';
import { registerMittrAuthRoutes } from './auth-routes.js';
import { resolveBroker } from './broker.js';
import { chooseSecretStore } from './secret-store.js';
import { deepLinkScheme } from './sign-in.js';

const SIGNED_IN_EVENT = 'mittrcraft:signed-in';

/**
 * Mittr on the server: sign-in through the platform's desktop flow, the
 * account store, and the session refresh later parts (the shim, the catalog)
 * build on. On the desktop the shell's `mittrcraft[-dev]://auth/callback`
 * deep link finishes a sign-in the same way the callback route does.
 *
 * Returns what the server plugin merges: an engine env, a config fragment and
 * a dispose that does no network I/O, so it can never hold up shutdown.
 */
export function setupMittr(context, { env = process.env, fetchImpl = (...args) => fetch(...args), accountHomeExists = null } = {}) {
  const { app, express, dataDir, logger = console, host = null } = context;
  const broker = resolveBroker(env);
  const scheme = deepLinkScheme(env);
  const { encrypt, decrypt, refusal } = chooseSecretStore({ host, logger });
  const store = createAccountStore({ dataDir, encrypt, decrypt, logger, accountHomeExists });

  const { completeSignIn } = registerMittrAuthRoutes(app, {
    express,
    broker,
    store,
    scheme,
    fetchImpl,
    signInRefusal: refusal,
    logger,
  });

  const unregisterDeepLink = host?.deepLinks?.register({
    host: 'auth',
    handle: async (link) => {
      await completeSignIn(link.raw);
      return { emit: SIGNED_IN_EVENT };
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

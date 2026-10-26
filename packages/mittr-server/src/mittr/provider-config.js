import { MITTR_PROVIDER_ID } from './policies.js';
import { SHIM_PREFIX } from './shim-routes.js';

const PROVIDER_NAME = 'Mittr';
const PROVIDER_PACKAGE = 'aisdk:@ai-sdk/openai-compatible';
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'];

/** Where the engine reaches the shim: always loopback, on the server's own port. */
export const shimBaseUrl = (port) => `http://127.0.0.1:${port}${SHIM_PREFIX}`;

/**
 * Mittr as one OpenAI-compatible engine provider whose models are the
 * account's agents. No models means no provider at all, so the picker never
 * shows an empty Mittr entry.
 */
export const mittrProviderFragment = ({ shimBaseUrl: baseURL, models }) => {
  if (models.length === 0) return {};
  return {
    providers: {
      [MITTR_PROVIDER_ID]: {
        name: PROVIDER_NAME,
        package: PROVIDER_PACKAGE,
        settings: { baseURL },
        models: Object.fromEntries(models.map(({ alias, label }) => [
          alias,
          { modelID: alias, name: label || alias, capabilities: { tools: true } },
        ])),
      },
    },
  };
};

const hostList = (value) => String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);

/**
 * `NO_PROXY` and `no_proxy` for the engine with loopback added, so a proxy in
 * the person's environment never receives the engine's calls to the shim, key
 * included. A spelling that is unset starts from the other one, so the hosts
 * the person already exempts stay exempt whichever spelling the engine reads.
 */
export const loopbackProxyExemption = (env) => {
  const upper = hostList(env.NO_PROXY);
  const lower = hostList(env.no_proxy);
  const withLoopback = (entries) => [...entries, ...LOOPBACK_HOSTS.filter((host) => !entries.includes(host))].join(',');
  return {
    NO_PROXY: withLoopback(upper.length > 0 ? upper : lower),
    no_proxy: withLoopback(lower.length > 0 ? lower : upper),
  };
};

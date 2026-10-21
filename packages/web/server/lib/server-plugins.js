import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

/**
 * In-process server plugins for a build that ships its own (the desktop shell
 * names them in `OPENCHAMBER_SERVER_PLUGINS`). Each one is an ESM file whose
 * default export receives the server's context once at startup (`app`,
 * `express`, `dataDir`, `logger`, and handles on the server, its settings,
 * events, the managed OpenCode, git and shutdown; `index.js` builds it) and may
 * mount routes on `app`. It may return:
 *
 * - `engineEnv()`: variables added to the managed OpenCode's environment on
 *   every start;
 * - `managedConfig()`: an OpenCode config fragment written into the managed
 *   config layer beside OpenChamber's own plugins, read again on every start
 *   and every managed-config refresh;
 * - `dispose()`: run on shutdown, before OpenCode stops.
 *
 * Without the variable nothing loads.
 *
 * A plugin that fails to load or set up fails the server start: a build that
 * relies on a plugin must not run as if it were absent.
 */

const SERVER_PLUGINS_ENV = 'OPENCHAMBER_SERVER_PLUGINS';

const specifiersSchema = z.array(z.string().refine((entry) => path.isAbsolute(entry)));

/** Absolute plugin paths from the environment; unset or blank means none. */
export const readServerPluginSpecifiers = (env = process.env) => {
  const raw = (env[SERVER_PLUGINS_ENV] ?? '').trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${SERVER_PLUGINS_ENV} is not valid JSON: ${error.message}`);
  }
  const specifiers = specifiersSchema.safeParse(parsed);
  if (!specifiers.success) throw new Error(`${SERVER_PLUGINS_ENV} must be a JSON array of absolute file paths`);
  return specifiers.data;
};

const isPlainObject = (value) => value !== null && value !== undefined && Object.getPrototypeOf(value) === Object.prototype;

// Lists that every config layer adds to rather than replaces, by key path.
const isConcatenated = (keyPath) => keyPath === 'plugins' || keyPath === 'experimental.policies';

const mergeAt = (base, override, parentPath) => {
  const merged = new Map(Object.entries(base));
  for (const [key, value] of Object.entries(override)) {
    const keyPath = parentPath ? `${parentPath}.${key}` : key;
    const current = merged.get(key);
    if (isConcatenated(keyPath) && Array.isArray(current) && Array.isArray(value)) {
      merged.set(key, [...current, ...value]);
    } else if (isPlainObject(current) && isPlainObject(value)) {
      merged.set(key, mergeAt(current, value, keyPath));
    } else {
      merged.set(key, value);
    }
  }
  return Object.fromEntries(merged);
};

/**
 * Merges two OpenCode config fragments: objects deep-merged, the later one wins
 * on scalars and on other arrays, and `plugins` and `experimental.policies`
 * concatenated in order.
 */
export const mergeEngineConfig = (base, override) => mergeAt(base, override, '');

/** Sets up each plugin in order; later plugins' engine variables and config win. */
export const loadServerPlugins = async ({ specifiers, context }) => {
  const plugins = [];
  for (const specifier of specifiers) {
    const { default: setup } = await import(pathToFileURL(specifier).href);
    if (!(setup instanceof Function)) throw new Error(`Server plugin ${specifier} must export a default function`);
    plugins.push({ specifier, ...((await setup(context)) ?? {}) });
  }

  return {
    engineEnv: async () => {
      const env = {};
      for (const plugin of plugins) {
        if (plugin.engineEnv instanceof Function) Object.assign(env, await plugin.engineEnv());
      }
      return env;
    },
    managedConfig: async () => {
      let config = {};
      for (const plugin of plugins) {
        if (!(plugin.managedConfig instanceof Function)) continue;
        const fragment = await plugin.managedConfig();
        if (!isPlainObject(fragment)) throw new Error(`Server plugin ${plugin.specifier} managedConfig() must return a JSON object`);
        config = mergeEngineConfig(config, fragment);
      }
      return config;
    },
    neverAutoAnswer: (permission) => plugins.some((plugin) => {
      if (!(plugin.neverAutoAnswer instanceof Function)) return false;
      try {
        return plugin.neverAutoAnswer(permission) === true;
      } catch {
        return true;
      }
    }),
    // Last set up, first disposed; one plugin that fails to stop does not keep
    // the others running.
    dispose: async () => {
      for (const plugin of [...plugins].reverse()) {
        if (!(plugin.dispose instanceof Function)) continue;
        try {
          await plugin.dispose();
        } catch (error) {
          context.logger.warn(`Server plugin ${plugin.specifier} failed to stop:`, error instanceof Error ? error.message : String(error));
        }
      }
    },
  };
};

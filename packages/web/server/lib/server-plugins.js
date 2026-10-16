import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

/**
 * In-process server plugins for a build that ships its own (the desktop shell
 * names them in `OPENCHAMBER_SERVER_PLUGINS`). Each one is an ESM file whose
 * default export receives `{ app, dataDir, logger }` once at startup, may mount
 * routes on `app`, and may return `engineEnv()`: variables added to the managed
 * OpenCode's environment on every start. Without the variable nothing loads.
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

/** Sets up each plugin in order; later plugins' engine variables win. */
export const loadServerPlugins = async ({ specifiers, context }) => {
  const plugins = [];
  for (const specifier of specifiers) {
    const { default: setup } = await import(pathToFileURL(specifier).href);
    if (!(setup instanceof Function)) throw new Error(`Server plugin ${specifier} must export a default function`);
    plugins.push((await setup(context)) ?? {});
  }

  return {
    engineEnv: async () => {
      const env = {};
      for (const plugin of plugins) {
        if (plugin.engineEnv instanceof Function) Object.assign(env, await plugin.engineEnv());
      }
      return env;
    },
  };
};

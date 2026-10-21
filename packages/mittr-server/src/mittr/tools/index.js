import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createToolsCallback } from './callback.js';
import { materializeToolsPlugin, toolsFragment, toolsPluginDir, toolsPluginSource } from './plugin-source.js';
import { MITTR_TOOLS, MittrToolError } from './registry.js';

export const CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const NOT_SIGNED_IN = 'Not signed in to Mittr. Sign in to continue.';

const TITLES = Object.freeze({
  [MITTR_TOOLS.computer]: 'The Computer tool',
  [MITTR_TOOLS.chrome]: 'The Chrome tool',
  [MITTR_TOOLS.work]: 'The work tool',
});

const bundledBinary = ({ dirFromEnv, resourcesDir, name, exists }) => {
  const fromEnv = String(dirFromEnv ?? '').trim();
  const candidates = [fromEnv ? path.join(fromEnv, name) : null, resourcesDir ? path.join(resourcesDir, name, name) : null];
  return candidates.find((candidate) => candidate !== null && exists(candidate)) ?? null;
};

export const bundledDrivers = ({ resourcesDir, env, exists = fs.existsSync }) => ({
  computer: () => bundledBinary({ dirFromEnv: env.MITTRCRAFT_BUNDLED_CUA_DRIVER_DIR, resourcesDir, name: 'cua-driver', exists }),
  chrome: () => bundledBinary({ dirFromEnv: env.MITTRCRAFT_BUNDLED_AGENT_BROWSER_DIR, resourcesDir, name: 'agent-browser', exists }),
  chromeInstalled: () => exists(CHROME_EXECUTABLE),
});

export function setupMittrTools(context, {
  registry,
  mittrSettings,
  resourcesDir = null,
  env = process.env,
  signedIn,
  personalDesktop,
  refresh,
  platform,
  drivers = bundledDrivers({ resourcesDir, env }),
  logger = console,
}) {
  const { app, dataDir, server, opencode, events, settings: upstreamSettings, control } = context;

  const carried = mittrSettings.carryParkedToolSettings().then(
    (tools) => {
      if (tools) logger.log('[mittr] carried the 1.22 Computer and Chrome tool settings');
    },
    (error) => logger.warn('[mittr] could not carry the 1.22 tool settings; trying again next start:', error?.message ?? error),
  );

  const offered = {
    [MITTR_TOOLS.computer]: () => personalDesktop() && drivers.computer() !== null,
    [MITTR_TOOLS.chrome]: () => personalDesktop() && drivers.chrome() !== null && drivers.chromeInstalled(),
    [MITTR_TOOLS.work]: () => signedIn(),
  };
  const switchedOn = {
    [MITTR_TOOLS.computer]: ({ tools }) => tools.computer !== false,
    [MITTR_TOOLS.chrome]: ({ tools }) => tools.chrome !== false,
    [MITTR_TOOLS.work]: ({ upstream }) => upstream?.agentControlToolEnabled !== false,
  };

  const readSwitches = async () => {
    await carried;
    const [{ tools }, upstream] = await Promise.all([
      mittrSettings.read(),
      Promise.resolve().then(() => upstreamSettings.read()).catch(() => null),
    ]);
    return { tools, upstream };
  };

  const included = (name, switches) => Object.hasOwn(offered, name) && offered[name]() && switchedOn[name](switches);

  const refusalFor = async (name) => {
    if (!Object.hasOwn(offered, name)) return new MittrToolError('This tool is not available in this install', 503);
    if (!offered[name]()) {
      return name === MITTR_TOOLS.work ? new MittrToolError(NOT_SIGNED_IN, 401) : new MittrToolError(`${TITLES[name]} is not available in this install`, 503);
    }
    if (switchedOn[name](await readSwitches())) return null;
    return name === MITTR_TOOLS.work
      ? new MittrToolError(`${TITLES[name]} is off while the control tool is turned off in Settings`, 403)
      : new MittrToolError(`${TITLES[name]} is turned off in Settings → Integrations`, 403);
  };

  const callback = createToolsCallback({ crypto, registry, resolveSessionDirectory: control.resolveSessionDirectory, refusalFor, logger });
  callback.register(app);

  const signature = async () => {
    const switches = await readSwitches();
    const tools = registry.tools().filter((tool) => included(tool.name, switches));
    return tools.length === 0 ? '' : toolsPluginSource({ tools, codeMode: switches.upstream?.agentToolsCodeMode === true });
  };

  const render = async () => {
    const source = await signature();
    if (!source) return { fragment: {}, signature: source };
    try {
      return { fragment: toolsFragment(await materializeToolsPlugin({ dataDir, source })), signature: source };
    } catch (error) {
      const dir = toolsPluginDir(dataDir);
      if (fs.existsSync(path.join(dir, 'index.js'))) {
        logger.warn('[mittr] could not rewrite the MittrCraft tools plugin; keeping the one already written:', error?.message ?? error);
        return { fragment: toolsFragment(dir), signature: source };
      }
      logger.warn('[mittr] could not write the MittrCraft tools plugin; trying again on the next config write:', error?.message ?? error);
      return { fragment: {}, signature: source };
    }
  };

  const switches = async () => {
    const { tools } = await readSwitches();
    return { computer: tools.computer, chrome: tools.chrome };
  };

  const applySwitches = async (patch) => {
    await carried;
    await mittrSettings.update({ tools: patch });
    await refresh();
    return switches();
  };

  const unsubscribeReady = opencode.onReady(() => callback.engineReady());
  const unsubscribeEvents = events.subscribe((event) => {
    for (const payload of event?.translated?.() ?? []) {
      if (payload.type === 'session.idle' && payload.properties?.aborted === true) callback.abortSession(payload.properties.sessionID);
    }
  });

  return {
    engineEnv: () => {
      const port = server.port();
      return port === null ? {} : callback.engineEnv(port);
    },
    render,
    signature,
    managedConfig: async () => (await render()).fragment,
    applySwitches,
    switches,
    dispose: async () => {
      unsubscribeReady();
      unsubscribeEvents();
    },
  };
}

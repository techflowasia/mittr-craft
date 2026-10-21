import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBrowserStepper } from './browser-stepper.js';
import { createToolsCallback } from './callback.js';
import { CHROME_PERMISSION, createChromeSiteApprovals, createEnginePermissions, isChromePermission, subscribeApprovals } from './chrome-approvals.js';
import { CHROME_EXECUTABLE, createChromeControl, resolveAgentBrowser, resolveChrome } from './chrome-control.js';
import { chromeToolDescription, chromeToolParameters, createChromeService, registerChromeActions } from './chrome-service.js';
import { registerComputerActions } from './computer-actions.js';
import { createComputerControl, createLaunchApp, resolveCuaDriver } from './computer-control.js';
import { materializeToolsPlugin, toolsFragment, toolsPluginDir, toolsPluginSource } from './plugin-source.js';
import { MITTR_TOOLS, MittrToolError } from './registry.js';
import { CAPTURE_TOOL } from './screenshots.js';
import { registerMittrToolsSettingsRoutes } from './settings-routes.js';
import { NOT_SIGNED_IN, registerWorkActions } from './work-lookup.js';

export const CHROME_CLOSE_TIMEOUT_MS = 3_000;

const TITLES = Object.freeze({
  [MITTR_TOOLS.computer]: 'The Computer tool',
  [MITTR_TOOLS.chrome]: 'The Chrome tool',
  [MITTR_TOOLS.work]: 'The work tool',
});

const enginePortOf = (opencode) => {
  try {
    return Number(new URL(opencode.url('/')).port) || null;
  } catch {
    return null;
  }
};

const settledWithin = (work, ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
  const done = () => {
    clearTimeout(timer);
    resolve();
  };
  work.then(done, done);
});

const readTextOrNull = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

export const bundledDrivers = ({ resourcesDir, env, exists = fs.existsSync }) => ({
  computer: () => resolveCuaDriver({ resourcesDir, env, exists }),
  chrome: () => resolveAgentBrowser({ resourcesDir, env, exists }),
  chromePath: () => resolveChrome({ home: env.HOME || os.homedir(), exists }),
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
  chromeApprovals = null,
  engineFetch = fetch,
  logger = console,
}) {
  const { app, express, dataDir, server, opencode, events, settings: upstreamSettings, control } = context;
  const approvals = chromeApprovals ?? createChromeSiteApprovals({
    settings: mittrSettings,
    engine: createEnginePermissions({ opencode, fetchImpl: engineFetch }),
    defaultDirectory: () => opencode.defaultDirectory?.() ?? null,
    logger,
  });

  const carried = mittrSettings.carryParkedToolSettings().then(
    (tools) => {
      if (tools) logger.log('[mittr] carried the 1.22 Computer and Chrome tool settings');
    },
    (error) => logger.warn('[mittr] could not carry the 1.22 tool settings; trying again next start:', error?.message ?? error),
  );

  const chromeDriverOffered = () => personalDesktop() && drivers.chrome() !== null;
  const offered = {
    [MITTR_TOOLS.computer]: () => personalDesktop() && drivers.computer() !== null,
    [MITTR_TOOLS.chrome]: () => chromeDriverOffered() && drivers.chromePath() !== null,
    [MITTR_TOOLS.work]: () => signedIn(),
  };
  registerComputerActions(registry, {
    control: createComputerControl({ binary: drivers.computer() }),
    launchApp: createLaunchApp(),
    writeScreenshot: control.writeScreenshot,
    offered: offered[MITTR_TOOLS.computer],
  });
  const chromeControl = createChromeControl({
    binary: drivers.chrome(),
    dataDir,
    chromePath: drivers.chromePath() ?? CHROME_EXECUTABLE,
    locateChrome: () => drivers.chromePath(),
    env,
  });
  let markSwept;
  const swept = new Promise((resolve) => {
    markSwept = resolve;
  });
  const stepper = createBrowserStepper(platform ?? {});
  const chrome = createChromeService({
    control: chromeControl,
    settings: mittrSettings,
    approvals,
    writeScreenshot: control.writeScreenshot,
    ownPorts: () => [server.port(), enginePortOf(opencode)].filter(Number.isInteger),
    ready: swept,
    stepper,
  });
  registerChromeActions(registry, {
    service: chrome,
    available: () => chromeControl.available && offered[MITTR_TOOLS.chrome](),
    doTask: () => stepper !== null && signedIn(),
  });
  registerWorkActions(registry, platform ?? {});
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

  const wrapCapture = ({ upstream }) => upstream?.agentWebToolEnabled !== false;

  const switchRefusal = async (name) => {
    if (!Object.hasOwn(switchedOn, name) || switchedOn[name](await readSwitches())) return null;
    return name === MITTR_TOOLS.work
      ? new MittrToolError(`${TITLES[name]} is off while the control tool is turned off in Settings`, 403)
      : new MittrToolError(`${TITLES[name]} is turned off in Settings → Integrations`, 403);
  };
  registry.useSwitches(switchRefusal);

  const refusalFor = async (name) => {
    if (name === CAPTURE_TOOL) return wrapCapture(await readSwitches()) ? null : new MittrToolError('The in-app browser tool is turned off in Settings', 403);
    if (!Object.hasOwn(offered, name)) return new MittrToolError('This tool is not available in this install', 503);
    if (!offered[name]()) {
      return name === MITTR_TOOLS.work ? new MittrToolError(NOT_SIGNED_IN, 401) : new MittrToolError(`${TITLES[name]} is not available in this install`, 503);
    }
    return switchRefusal(name);
  };

  const callback = createToolsCallback({
    crypto,
    registry,
    resolveSessionDirectory: control.resolveSessionDirectory,
    refusalFor,
    screenshotFolder: control.SCREENSHOT_DIRECTORY,
    logger,
  });
  callback.register(app);

  const signature = async () => {
    const switches = await readSwitches();
    const wrap = wrapCapture(switches);
    const tools = registry.tools()
      .filter((tool) => included(tool.name, switches))
      .map((tool) => {
        if (tool.name !== MITTR_TOOLS.chrome) return tool;
        const doTask = tool.definitions.some(({ action }) => action === 'chrome.do');
        return { ...tool, description: chromeToolDescription({ webTool: wrap, doTask }), parameters: chromeToolParameters({ doTask }) };
      });
    if (tools.length === 0 && !wrap) return '';
    const askPermissions = tools.some((tool) => tool.name === MITTR_TOOLS.chrome) ? [CHROME_PERMISSION] : [];
    return toolsPluginSource({ tools, codeMode: switches.upstream?.agentToolsCodeMode === true, wrapCapture: wrap, askPermissions });
  };

  const render = async () => {
    const source = await signature();
    if (!source) return { fragment: {}, signature: source };
    try {
      return { fragment: toolsFragment(await materializeToolsPlugin({ dataDir, source })), signature: source };
    } catch (error) {
      const dir = toolsPluginDir(dataDir);
      const written = readTextOrNull(path.join(dir, 'index.js'));
      if (written !== null) {
        logger.warn('[mittr] could not rewrite the MittrCraft tools plugin; the engine keeps the one already written, and the next config write tries again:', error?.message ?? error);
        return { fragment: toolsFragment(dir), signature: written };
      }
      logger.warn('[mittr] could not write the MittrCraft tools plugin; the engine config leaves the tools out, and the next config write tries again:', error?.message ?? error);
      return { fragment: {}, signature: '' };
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

  const settingsView = async () => {
    await carried;
    const { tools } = await mittrSettings.read();
    const chromeOffered = chromeDriverOffered();
    return {
      computer: { offered: offered[MITTR_TOOLS.computer](), enabled: tools.computer },
      chrome: chromeOffered
        ? { offered: true, chromeInstalled: drivers.chromePath() !== null, enabled: tools.chrome, profile: tools.chromeProfile, headed: tools.chromeHeaded, approvedHosts: tools.chromeApprovedHosts }
        : { offered: false, chromeInstalled: false, enabled: tools.chrome, profile: null, headed: false, approvedHosts: [] },
    };
  };

  registerMittrToolsSettingsRoutes(app, {
    express,
    host: context.host,
    requestScope: context.requestScope,
    view: settingsView,
    apply: applySwitches,
    profiles: () => chrome.profiles(),
    removeHost: (host) => chrome.removeHost(host),
    logger,
  });

  const unsubscribeReady = opencode.onReady(() => callback.engineReady());
  const unsubscribeApprovals = subscribeApprovals(events, approvals);
  const unsubscribeEvents = events.subscribe((event) => {
    for (const payload of event?.translated?.() ?? []) {
      if (payload.type === 'session.idle' && payload.properties?.aborted === true) callback.abortSession(payload.properties.sessionID);
      if (payload.type === 'session.deleted') void chrome.closeSession(payload.properties?.info?.id);
    }
  });

  const closeEveryChrome = () => {
    const controller = new AbortController();
    const closing = chrome.closeAll({ signal: controller.signal });
    return settledWithin(closing, CHROME_CLOSE_TIMEOUT_MS).finally(() => controller.abort());
  };
  void closeEveryChrome().then(markSwept);

  let disposed = null;

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
    chrome,
    neverAutoAnswer: isChromePermission,
    accountChanged: () => {
      callback.retire();
      chrome.forgetEveryGrant();
      return closeEveryChrome();
    },
    dispose: () => {
      disposed ??= (async () => {
        unsubscribeReady();
        unsubscribeEvents();
        unsubscribeApprovals();
        await closeEveryChrome();
      })();
      return disposed;
    },
  };
}

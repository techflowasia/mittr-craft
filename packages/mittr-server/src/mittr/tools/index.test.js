import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { MARKER_PNG } from '../../../../../scripts/mittr/probe-tool-plugin.mjs';
import { OPENCHAMBER_ALL_ACTIONS } from '../../../../web/server/lib/openchamber-control/actions.js';
import { SCREENSHOT_DIRECTORY, writeScreenshot } from '../../../../web/server/lib/openchamber-control/screenshots.js';
import { createMittrSettings } from '../mittr-settings.js';
import { deferred, listen, tempDataDir } from '../test-helpers.js';
import { CHROME_EXECUTABLE, bundledDrivers, setupMittrTools } from './index.js';
import { MITTR_TOOLS, createMittrActionRegistry } from './registry.js';

const recordingLogger = () => {
  const lines = [];
  const record = (...args) => lines.push(args.join(' '));
  return { lines, log: record, warn: record, error: record };
};

const ALL_DRIVERS = { computer: () => '/r/cua-driver/cua-driver', chrome: () => '/r/agent-browser/agent-browser', chromeInstalled: () => true };

const registerFakeTools = (registry, { hang } = {}) => {
  const runs = [];
  for (const [name, action] of [[MITTR_TOOLS.computer, 'computer.list_apps'], [MITTR_TOOLS.chrome, 'chrome.open'], [MITTR_TOOLS.work, 'jira.get_issue']]) {
    registry.defineTool({ name, description: `${name} description`, parameters: { value: { type: 'string' } } });
    registry.register({
      action,
      tool: name,
      title: action,
      description: `${action} description`,
      effect: 'read',
      execute: async (input, ctx) => {
        runs.push({ action, ctx });
        if (hang) await hang(ctx);
        return { ran: action };
      },
    });
  }
  return runs;
};

const setUp = async (t, {
  dataDir = tempDataDir(t),
  drivers = ALL_DRIVERS,
  personalDesktop = () => true,
  signedIn = () => true,
  upstreamSettings = {},
  port = 4100,
  hang,
  resolveSessionDirectory = async (id) => `/work/${id}`,
} = {}) => {
  const registry = createMittrActionRegistry({ control: { all: OPENCHAMBER_ALL_ACTIONS, execute: async () => ({}) } });
  const runs = registerFakeTools(registry, { hang });
  const readyListeners = new Set();
  const eventListeners = new Set();
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  const state = { upstreamSettings, port, refreshes: 0 };
  const context = {
    app,
    dataDir,
    server: { port: () => state.port },
    opencode: {
      onReady: (listener) => {
        readyListeners.add(listener);
        return () => readyListeners.delete(listener);
      },
    },
    events: {
      subscribe: (listener) => {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
    },
    settings: {
      read: async () => {
        if (state.upstreamSettings instanceof Error) throw state.upstreamSettings;
        return state.upstreamSettings;
      },
    },
    control: { resolveSessionDirectory, writeScreenshot, SCREENSHOT_DIRECTORY },
  };
  const logger = recordingLogger();
  const mittrSettings = createMittrSettings({ dataDir, logger });
  let tools = null;
  tools = setupMittrTools(context, {
    registry,
    mittrSettings,
    signedIn: () => signedIn(),
    personalDesktop: () => personalDesktop(),
    refresh: async () => {
      state.refreshes += 1;
      await tools.managedConfig();
    },
    drivers,
    logger,
  });
  t.after(() => tools.dispose());
  const base = await listen(t, app);
  const call = async (body) => {
    const { MITTRCRAFT_TOOLS_URL: url, MITTRCRAFT_TOOLS_TOKEN: token } = tools.engineEnv();
    const response = await fetch(url.replace('http://127.0.0.1:4100', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return response.json();
  };
  const pluginSource = () => fs.readFileSync(path.join(dataDir, 'engine-plugins', 'mittrcraft-tools', 'index.js'), 'utf8');
  const fireReady = () => { for (const listener of readyListeners) listener(); };
  const emit = (payloads) => { for (const listener of eventListeners) listener({ payload: {}, translated: () => payloads }); };
  return { tools, state, logger, dataDir, mittrSettings, call, pluginSource, fireReady, emit, runs, readyListeners, eventListeners };
};

const toolNamesIn = (source) => [...source.matchAll(/name: "(mittrcraft_[a-z]+)"/g)].map((match) => match[1]);

test('every tool this install offers and the person left on is in the plugin, which the managed config loads', async (t) => {
  const { tools, dataDir, pluginSource } = await setUp(t);
  assert.deepEqual(await tools.managedConfig(), { plugins: [path.join(dataDir, 'engine-plugins', 'mittrcraft-tools')] });
  assert.deepEqual(toolNamesIn(pluginSource()), ['mittrcraft_computer', 'mittrcraft_chrome', 'mittrcraft_work']);
});

test('turning Chrome off removes its tool from the plugin and refreshes the managed config', async (t) => {
  const { tools, state, pluginSource, dataDir } = await setUp(t);
  await tools.managedConfig();

  assert.deepEqual(await tools.applySwitches({ chrome: false }), { computer: true, chrome: false });

  assert.equal(state.refreshes, 1);
  assert.deepEqual(toolNamesIn(pluginSource()), ['mittrcraft_computer', 'mittrcraft_work']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'mittr-settings.json'), 'utf8')).tools.chrome, false);
  assert.deepEqual(await tools.switches(), { computer: true, chrome: false });
});

test('a switch that cannot be stored refreshes nothing', async (t) => {
  const { tools, state } = await setUp(t);
  await assert.rejects(tools.applySwitches({ chrome: 'off' }), /Unknown or invalid tool setting: chrome/);
  assert.equal(state.refreshes, 0);
});

test('a hosted runtime offers no computer or chrome tool', async (t) => {
  const { tools, pluginSource } = await setUp(t, { personalDesktop: () => false });
  await tools.managedConfig();
  assert.deepEqual(toolNamesIn(pluginSource()), ['mittrcraft_work']);
});

test('an unbundled driver offers no tool for it', async (t) => {
  const noComputer = await setUp(t, { drivers: { ...ALL_DRIVERS, computer: () => null } });
  await noComputer.tools.managedConfig();
  assert.deepEqual(toolNamesIn(noComputer.pluginSource()), ['mittrcraft_chrome', 'mittrcraft_work']);

  for (const drivers of [{ ...ALL_DRIVERS, chrome: () => null }, { ...ALL_DRIVERS, chromeInstalled: () => false }]) {
    const noChrome = await setUp(t, { drivers });
    await noChrome.tools.managedConfig();
    assert.deepEqual(toolNamesIn(noChrome.pluginSource()), ['mittrcraft_computer', 'mittrcraft_work']);
  }
});

test('the work tool needs a signed-in account and the control switch', async (t) => {
  const signedOut = await setUp(t, { signedIn: () => false });
  await signedOut.tools.managedConfig();
  assert.deepEqual(toolNamesIn(signedOut.pluginSource()), ['mittrcraft_computer', 'mittrcraft_chrome']);

  const controlOff = await setUp(t, { upstreamSettings: { agentControlToolEnabled: false } });
  await controlOff.tools.managedConfig();
  assert.deepEqual(toolNamesIn(controlOff.pluginSource()), ['mittrcraft_computer', 'mittrcraft_chrome']);

  const unreadable = await setUp(t);
  unreadable.state.upstreamSettings = new Error('locked');
  await unreadable.tools.managedConfig();
  assert.deepEqual(toolNamesIn(unreadable.pluginSource()), ['mittrcraft_computer', 'mittrcraft_chrome', 'mittrcraft_work'], 'an unreadable settings file reads as upstream\'s defaults');
});

test('Code Mode follows upstream\'s setting', async (t) => {
  const { tools, state, pluginSource } = await setUp(t);
  await tools.managedConfig();
  assert.equal(pluginSource().split('codemode: false').length - 1, 3);
  state.upstreamSettings = { agentToolsCodeMode: true };
  await tools.managedConfig();
  assert.equal(pluginSource().split('codemode: true').length - 1, 3);
  assert.equal(pluginSource().includes('codemode: false'), false);
});

test('with no tool to offer and the panel browser tool off the managed config adds nothing', async (t) => {
  const { tools, dataDir } = await setUp(t, { personalDesktop: () => false, signedIn: () => false, upstreamSettings: { agentWebToolEnabled: false } });
  assert.deepEqual(await tools.managedConfig(), {});
  assert.equal(await tools.signature(), '');
  assert.equal(fs.existsSync(path.join(dataDir, 'engine-plugins')), false);
});

test('the panel tool\'s capture is wrapped while upstream\'s web tool is on, even with no Mittr tool to offer', async (t) => {
  const { tools, state, dataDir, pluginSource } = await setUp(t, { personalDesktop: () => false, signedIn: () => false });
  assert.deepEqual(await tools.managedConfig(), { plugins: [path.join(dataDir, 'engine-plugins', 'mittrcraft-tools')] });
  assert.deepEqual(toolNamesIn(pluginSource()), []);
  assert.match(pluginSource(), /tools\.update\(CAPTURE_TOOL,/);
  const wrapped = await tools.signature();

  state.upstreamSettings = { agentWebToolEnabled: false };
  assert.equal(await tools.signature(), '');

  state.upstreamSettings = new Error('locked');
  assert.equal(await tools.signature(), wrapped, 'an unreadable settings file reads as upstream\'s default, web tool on');

  const withTools = await setUp(t, { upstreamSettings: { agentWebToolEnabled: false } });
  await withTools.tools.managedConfig();
  assert.doesNotMatch(withTools.pluginSource(), /openchamber_web/);
  assert.deepEqual(toolNamesIn(withTools.pluginSource()), ['mittrcraft_computer', 'mittrcraft_chrome', 'mittrcraft_work']);
});

test('the callback answers a panel capture\'s image from the session\'s project, and refuses it while the web tool is off', async (t) => {
  const project = fs.realpathSync(tempDataDir(t));
  const saved = await writeScreenshot({ directory: project, base64: MARKER_PNG, mime: 'image/png', label: 'home' });
  const { call, state, runs } = await setUp(t, { resolveSessionDirectory: async (id) => (id === 'ses_1' ? project : null) });
  const body = { tool: 'openchamber_web', internal: 'capture-image', path: saved.path, sessionID: 'ses_1' };

  assert.deepEqual(await call(body), { schemaVersion: 1, ok: true, action: 'capture-image', data: { image: { base64: MARKER_PNG, mime: 'image/png' } } });

  state.upstreamSettings = { agentWebToolEnabled: false };
  assert.deepEqual(await call(body), { schemaVersion: 1, ok: false, action: 'capture-image', error: { message: 'The in-app browser tool is turned off in Settings', kind: 'usage' } });
  assert.deepEqual(runs, []);
});

test('the signature changes when the offered tools change, and only then', async (t) => {
  const signedIn = { value: true };
  const { tools } = await setUp(t, { signedIn: () => signedIn.value });
  const before = await tools.signature();
  assert.equal(await tools.signature(), before);
  signedIn.value = false;
  assert.notEqual(await tools.signature(), before);
  assert.deepEqual((await tools.render()).signature, await tools.signature());
});

test('the callback refuses a tool that is switched off, and one this install cannot run', async (t) => {
  const { tools, call, runs } = await setUp(t, { drivers: { ...ALL_DRIVERS, computer: () => null } });
  await tools.applySwitches({ chrome: false });

  assert.deepEqual(await call({ tool: 'mittrcraft_chrome', input: { action: 'open' }, sessionID: 's1' }), {
    schemaVersion: 1, ok: false, action: 'open', error: { message: 'The Chrome tool is turned off in Settings → Integrations', kind: 'usage' },
  });
  assert.deepEqual(await call({ tool: 'mittrcraft_computer', input: { action: 'list_apps' }, sessionID: 's1' }), {
    schemaVersion: 1, ok: false, action: 'list_apps', error: { message: 'The Computer tool is not available in this install', kind: 'runtime' },
  });
  assert.deepEqual(runs, []);
  assert.deepEqual(await call({ tool: 'mittrcraft_work', input: { action: 'get_issue' }, sessionID: 's1' }), { schemaVersion: 1, ok: true, action: 'jira.get_issue', data: { ran: 'jira.get_issue' } });
  assert.deepEqual(runs.map(({ ctx }) => [ctx.directory, ctx.sessionId, ctx.surface, ctx.tool, ctx.via, ctx.scope]), [['/work/s1', 's1', 'agent', 'mittrcraft_work', 'engine', undefined]]);
});

test('the work tool answers a signed-out call with sign in first', async (t) => {
  const { call } = await setUp(t, { signedIn: () => false });
  assert.deepEqual((await call({ tool: 'mittrcraft_work', input: { action: 'get_issue' }, sessionID: 's1' })).error, { message: 'Not signed in to Mittr. Sign in to continue.', kind: 'usage' });
});

test('an aborted turn aborts its in-flight action', async (t) => {
  const started = deferred();
  const aborted = deferred();
  const { call, emit } = await setUp(t, {
    hang: (ctx) => new Promise((_resolve, reject) => {
      ctx.signal.addEventListener('abort', () => {
        aborted.resolve(true);
        reject(new Error('aborted'));
      }, { once: true });
      started.resolve();
    }),
  });
  const pending = call({ tool: 'mittrcraft_chrome', input: { action: 'open' }, sessionID: 'ses_9' });
  await started.promise;

  emit([{ type: 'session.idle', properties: { sessionID: 'ses_9' } }, { type: 'session.idle', properties: { sessionID: 'ses_other', aborted: true } }]);
  emit([{ type: 'session.idle', properties: { sessionID: 'ses_9', aborted: true } }]);

  assert.equal(await aborted.promise, true);
  assert.equal((await pending).ok, false);
});

test('each engine start gets the token minted before it, and the start before that is retired', async (t) => {
  const { tools, fireReady, call, state } = await setUp(t);
  const first = tools.engineEnv();
  assert.equal(first.MITTRCRAFT_TOOLS_URL, 'http://127.0.0.1:4100/mittr-tools/v1/call');
  fireReady();
  assert.equal((await call({ tool: 'mittrcraft_work', input: { action: 'get_issue' } })).ok, true);
  const second = tools.engineEnv();
  assert.notEqual(second.MITTRCRAFT_TOOLS_TOKEN, first.MITTRCRAFT_TOOLS_TOKEN);
  fireReady();
  assert.notEqual(tools.engineEnv().MITTRCRAFT_TOOLS_TOKEN, second.MITTRCRAFT_TOOLS_TOKEN);

  state.port = null;
  assert.deepEqual(tools.engineEnv(), {}, 'before the server listens there is no callback to name');
});

test('1.22 tool settings parked under mittr reach the first plugin', async (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ mittr: { agentChromeToolEnabled: false, agentComputerToolEnabled: true } }));
  const { tools, pluginSource, logger } = await setUp(t, { dataDir });
  await tools.managedConfig();
  assert.deepEqual(toolNamesIn(pluginSource()), ['mittrcraft_computer', 'mittrcraft_work']);
  assert.deepEqual(await tools.switches(), { computer: true, chrome: false });
  assert.ok(logger.lines.includes('[mittr] carried the 1.22 Computer and Chrome tool settings'), logger.lines.join('\n'));
});

test('a plugin that cannot be rewritten keeps the one already on disk', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const { tools, dataDir, logger } = await setUp(t);
  const config = await tools.managedConfig();
  const dir = path.join(dataDir, 'engine-plugins', 'mittrcraft-tools');
  fs.chmodSync(dir, 0o500);
  try {
    await tools.applySwitches({ computer: false });
    assert.deepEqual(await tools.managedConfig(), config);
    const rendered = await tools.render();
    assert.equal(rendered.signature, fs.readFileSync(path.join(dir, 'index.js'), 'utf8'), 'the signature is what the engine loads');
    assert.notEqual(rendered.signature, await tools.signature(), 'the wanted plugin is not recorded as written');
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.ok(logger.lines.some((line) => line.startsWith('[mittr] could not rewrite the MittrCraft tools plugin; the engine keeps the one already written, and the next config write tries again:')), logger.lines.join('\n'));
});

test('dispose stops listening for engine starts and events', async (t) => {
  const { tools, readyListeners, eventListeners } = await setUp(t);
  assert.equal(readyListeners.size, 1);
  assert.equal(eventListeners.size, 1);
  await tools.dispose();
  assert.equal(readyListeners.size, 0);
  assert.equal(eventListeners.size, 0);
});

test('the bundled drivers come from the env folder first, then the app resources, and Chrome from its install', (t) => {
  const root = tempDataDir(t);
  const resourcesDir = path.join(root, 'Resources');
  const envDir = path.join(root, 'env-cua');
  fs.mkdirSync(path.join(resourcesDir, 'cua-driver'), { recursive: true });
  fs.writeFileSync(path.join(resourcesDir, 'cua-driver', 'cua-driver'), '');

  const packed = bundledDrivers({ resourcesDir, env: {}, exists: fs.existsSync });
  assert.equal(packed.computer(), path.join(resourcesDir, 'cua-driver', 'cua-driver'));
  assert.equal(packed.chrome(), null);

  fs.mkdirSync(envDir);
  fs.writeFileSync(path.join(envDir, 'cua-driver'), '');
  assert.equal(bundledDrivers({ resourcesDir, env: { MITTRCRAFT_BUNDLED_CUA_DRIVER_DIR: envDir }, exists: fs.existsSync }).computer(), path.join(envDir, 'cua-driver'));
  assert.equal(bundledDrivers({ resourcesDir: null, env: {}, exists: fs.existsSync }).computer(), null);

  const checked = [];
  const installed = bundledDrivers({ resourcesDir: null, env: {}, exists: (file) => { checked.push(file); return true; } });
  assert.equal(installed.chromeInstalled(), true);
  assert.deepEqual(checked, [CHROME_EXECUTABLE]);
  assert.equal(CHROME_EXECUTABLE, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
});

test('a plugin that cannot be written leaves the tools out and records nothing as written', async (t) => {
  const { tools, dataDir, logger } = await setUp(t);
  fs.mkdirSync(path.join(dataDir, 'engine-plugins'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'engine-plugins', 'mittrcraft-tools'), 'in the way');
  assert.deepEqual(await tools.render(), { fragment: {}, signature: '' });
  assert.ok(logger.lines.some((line) => line.startsWith('[mittr] could not write the MittrCraft tools plugin; the engine config leaves the tools out, and the next config write tries again:')), logger.lines.join('\n'));
});

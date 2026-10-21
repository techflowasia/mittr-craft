import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { MARKER_PNG } from '../../../../../scripts/mittr/probe-tool-plugin.mjs';
import { OPENCHAMBER_ALL_ACTIONS } from '../../../../web/server/lib/openchamber-control/actions.js';
import { SCREENSHOT_DIRECTORY, writeScreenshot } from '../../../../web/server/lib/openchamber-control/screenshots.js';
import { createMittrSettings } from '../mittr-settings.js';
import { SCREEN_RECORDING_NOT_GRANTED, deferred, listen, stubAgentBrowser, stubCuaDriver, tempDataDir, until } from '../test-helpers.js';
import { CHROME_EXECUTABLE, chromeSessionName } from './chrome-control.js';
import { NO_APPROVALS } from './chrome-service.js';
import { CHROME_CLOSE_TIMEOUT_MS, bundledDrivers, setupMittrTools } from './index.js';
import { MITTR_TOOLS, createMittrActionRegistry } from './registry.js';

const recordingLogger = () => {
  const lines = [];
  const record = (...args) => lines.push(args.join(' '));
  return { lines, log: record, warn: record, error: record };
};

const ALL_DRIVERS = { computer: () => '/r/cua-driver/cua-driver', chrome: () => '/r/agent-browser/agent-browser', chromePath: () => CHROME_EXECUTABLE };

const registerFakeTools = (registry, { hang } = {}) => {
  const runs = [];
  for (const [name, action] of [[MITTR_TOOLS.work, 'jira.get_issue']]) {
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
  chromeApprovals = NO_APPROVALS,
  enginePort = 4096,
  engineBase = null,
} = {}) => {
  const registry = createMittrActionRegistry({ control: { all: OPENCHAMBER_ALL_ACTIONS, execute: async () => ({}) } });
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
      url: (route = '/') => `${engineBase ?? `http://127.0.0.1:${enginePort}`}${route}`,
      authHeaders: () => ({ authorization: 'Basic acme' }),
      defaultDirectory: () => '/work',
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
    chromeApprovals,
    logger,
  });
  const runs = registerFakeTools(registry, { hang });
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
  const emitRaw = (payload) => { for (const listener of eventListeners) listener({ payload, translated: () => [] }); };
  return { tools, state, logger, dataDir, mittrSettings, registry, call, pluginSource, fireReady, emit, emitRaw, runs, readyListeners, eventListeners };
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

  for (const drivers of [{ ...ALL_DRIVERS, chrome: () => null }, { ...ALL_DRIVERS, chromePath: () => null }]) {
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
  assert.doesNotMatch(withTools.pluginSource(), /openchamber_web/, 'neither the capture wrap nor the Chrome description names the panel tool while it is off');
  const webOn = await setUp(t);
  await webOn.tools.managedConfig();
  assert.match(webOn.pluginSource(), /To look at the app being built, use openchamber_web instead\./);
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
  const pending = call({ tool: 'mittrcraft_work', input: { action: 'get_issue' }, sessionID: 'ses_9' });
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

test('dispose stops listening for engine starts, events and Chrome site answers', async (t) => {
  const { tools, readyListeners, eventListeners } = await setUp(t);
  assert.equal(readyListeners.size, 1);
  assert.equal(eventListeners.size, 2);
  await tools.dispose();
  assert.equal(readyListeners.size, 0);
  assert.equal(eventListeners.size, 0);
});

test('a set driver folder is the only place a driver is looked for, otherwise the app resources, and Chrome from its install', (t) => {
  const root = tempDataDir(t);
  const resourcesDir = path.join(root, 'Resources');
  const envDir = path.join(root, 'env-cua');
  fs.mkdirSync(path.join(resourcesDir, 'cua-driver'), { recursive: true });
  fs.writeFileSync(path.join(resourcesDir, 'cua-driver', 'cua-driver'), '');

  const packed = bundledDrivers({ resourcesDir, env: {}, exists: fs.existsSync });
  assert.equal(packed.computer(), path.join(resourcesDir, 'cua-driver', 'cua-driver'));
  assert.equal(packed.chrome(), null);

  fs.mkdirSync(envDir);
  assert.equal(bundledDrivers({ resourcesDir, env: { MITTRCRAFT_BUNDLED_CUA_DRIVER_DIR: envDir }, exists: fs.existsSync }).computer(), null, 'a set folder without the driver is not a fall-through to the packed one');
  fs.writeFileSync(path.join(envDir, 'cua-driver'), '');
  assert.equal(bundledDrivers({ resourcesDir, env: { MITTRCRAFT_BUNDLED_CUA_DRIVER_DIR: envDir }, exists: fs.existsSync }).computer(), path.join(envDir, 'cua-driver'));
  fs.mkdirSync(path.join(resourcesDir, 'agent-browser'));
  fs.writeFileSync(path.join(resourcesDir, 'agent-browser', 'agent-browser'), '');
  assert.equal(bundledDrivers({ resourcesDir, env: { MITTRCRAFT_BUNDLED_AGENT_BROWSER_DIR: envDir }, exists: fs.existsSync }).chrome(), null, 'the agent-browser folder is held to the same rule');
  assert.equal(bundledDrivers({ resourcesDir: null, env: {}, exists: fs.existsSync }).computer(), null);

  const checked = [];
  const installed = bundledDrivers({ resourcesDir: null, env: { HOME: '/Users/person' }, exists: (file) => { checked.push(file); return file.startsWith('/Users/'); } });
  assert.equal(installed.chromePath(), '/Users/person/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.deepEqual(checked, [CHROME_EXECUTABLE, '/Users/person/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']);
});

test('a plugin that cannot be written leaves the tools out and records nothing as written', async (t) => {
  const { tools, dataDir, logger } = await setUp(t);
  fs.mkdirSync(path.join(dataDir, 'engine-plugins'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'engine-plugins', 'mittrcraft-tools'), 'in the way');
  assert.deepEqual(await tools.render(), { fragment: {}, signature: '' });
  assert.ok(logger.lines.some((line) => line.startsWith('[mittr] could not write the MittrCraft tools plugin; the engine config leaves the tools out, and the next config write tries again:')), logger.lines.join('\n'));
});

test('the computer tool runs the bundled driver for an engine call and saves its screenshot in the session\'s project', async (t) => {
  const project = fs.realpathSync(tempDataDir(t));
  const driver = stubCuaDriver(t, {
    list_apps: { apps: [{ name: 'Calculator', pid: 501, running: true, bundle_id: 'com.apple.calculator' }] },
    get_desktop_state: { screenshot_png_b64: MARKER_PNG, screenshot_mime_type: 'image/png', screen_width: 2, screen_height: 2 },
  });
  const { tools, call, pluginSource } = await setUp(t, {
    drivers: { ...ALL_DRIVERS, computer: () => driver },
    resolveSessionDirectory: async (id) => (id === 'ses_1' ? project : null),
  });
  await tools.managedConfig();
  assert.match(pluginSource(), /computer\.screenshot/);

  assert.deepEqual(await call({ tool: 'mittrcraft_computer', input: { action: 'list_apps' }, sessionID: 'ses_1' }), {
    schemaVersion: 1, ok: true, action: 'computer.list_apps', data: { apps: [{ name: 'Calculator', pid: 501, running: true, bundleId: 'com.apple.calculator' }] },
  });

  const shot = await call({ tool: 'mittrcraft_computer', input: { action: 'screenshot' }, sessionID: 'ses_1' });
  assert.equal(shot.ok, true);
  assert.match(shot.data.path, /^\.openchamber\/screenshots\/desktop-.+\.png$/);
  assert.deepEqual(shot.data.image, { base64: MARKER_PNG, mime: 'image/png' });
  assert.deepEqual(fs.readFileSync(path.join(project, shot.data.path)), Buffer.from(MARKER_PNG, 'base64'));
});

test('a missing grant reaches the agent as a plain sentence', async (t) => {
  const project = fs.realpathSync(tempDataDir(t));
  const { call } = await setUp(t, { drivers: { ...ALL_DRIVERS, computer: () => stubCuaDriver(t) }, resolveSessionDirectory: async () => project });
  assert.deepEqual(await call({ tool: 'mittrcraft_computer', input: { action: 'screenshot' }, sessionID: 'ses_1' }), {
    schemaVersion: 1,
    ok: false,
    action: 'computer.screenshot',
    error: { message: 'MittrCraft needs the Screen Recording permission for CuaDriver. Turn it on in System Settings → Privacy & Security → Screen Recording.', kind: 'usage' },
  });
  assert.equal(SCREEN_RECORDING_NOT_GRANTED, 'Screen Recording is NOT granted for this process.');
});

const everySite = () => {
  const record = { forgotten: [], forgotAll: 0 };
  return {
    record,
    isApproved: async () => true,
    ask: async () => 'reject',
    asked: () => {},
    replied: () => {},
    forgetSession: (sessionId) => record.forgotten.push(sessionId),
    forgetAll: () => { record.forgotAll += 1; },
    removeHost: async (host) => [host],
  };
};

const chromeSetUp = async (t, { driver = stubAgentBrowser(t, { png: MARKER_PNG }), ...options } = {}) => {
  const project = fs.realpathSync(tempDataDir(t));
  const chromeApprovals = everySite();
  const setup = await setUp(t, {
    drivers: { ...ALL_DRIVERS, chrome: () => driver.file },
    chromeApprovals,
    resolveSessionDirectory: async () => project,
    ...options,
  });
  const chrome = (action, parameters = {}, sessionID = 'ses_1') => setup.call({ tool: 'mittrcraft_chrome', input: { action, parameters }, sessionID });
  return { ...setup, driver, project, chrome, chromeApprovals };
};

test('the Chrome tool runs the bundled agent-browser for an engine call and saves its screenshot in the session\'s project', async (t) => {
  const { chrome, driver, project, dataDir, mittrSettings } = await chromeSetUp(t);
  assert.deepEqual(await chrome('open', { url: 'http://acme.example.test/' }), { schemaVersion: 1, ok: true, action: 'chrome.open', data: { url: 'http://acme.example.test/', title: 'Acme' } });
  assert.deepEqual((await chrome('snapshot')).data, { ran: 'snapshot', args: ['-i'] });
  const shot = await chrome('screenshot', { label: 'home' });
  assert.equal(shot.ok, true);
  assert.match(shot.data.path, /^\.openchamber\/screenshots\/home-.+\.png$/);
  assert.deepEqual(shot.data.image, { base64: MARKER_PNG, mime: 'image/png' });
  assert.deepEqual(fs.readFileSync(path.join(project, shot.data.path)), Buffer.from(MARKER_PNG, 'base64'));

  assert.equal((await mittrSettings.read()).tools.chromeProfile, 'Default', 'the only profile was chosen and stored');
  for (const { env, cwd, args } of driver.calls()) {
    assert.equal(env.AGENT_BROWSER_NAMESPACE, path.basename(dataDir));
    assert.equal(env.AGENT_BROWSER_EXECUTABLE_PATH, CHROME_EXECUTABLE);
    assert.equal(cwd, fs.realpathSync(dataDir));
    assert.deepEqual(args.slice(0, 2), ['--config', path.join(dataDir, 'mittr-agent-browser.json')]);
  }
});

test('chrome.open of this server\'s or the engine\'s own port is refused whatever the approvals', async (t) => {
  const { chrome, driver } = await chromeSetUp(t, { port: 4100, enginePort: 4096 });
  for (const url of ['http://127.0.0.1:4100/', 'http://localhost:4096/global/health']) {
    assert.deepEqual((await chrome('open', { url })).error, { message: 'That address is MittrCraft itself', kind: 'usage' }, url);
  }
  assert.equal(driver.commands().some(({ command }) => command[0] === 'open'), false);
});

test('a deleted session closes its Chrome', async (t) => {
  const { chrome, driver, emit, chromeApprovals } = await chromeSetUp(t);
  assert.equal((await chrome('open', { url: 'http://acme.example.test/' })).ok, true);
  emit([{ type: 'session.deleted', properties: { sessionID: 'ses_1', info: { id: 'ses_1' } } }]);
  await until(() => driver.commands().some(({ session, command }) => session === chromeSessionName('ses_1') && command[0] === 'close'));
  assert.deepEqual(chromeApprovals.record.forgotten, ['ses_1']);
});

test('an account switch closes every agent Chrome and forgets every session grant', async (t) => {
  const { chrome, driver, tools, chromeApprovals } = await chromeSetUp(t);
  assert.equal((await chrome('open', { url: 'http://acme.example.test/' }, 'ses_1')).ok, true);
  assert.equal((await chrome('open', { url: 'http://acme.example.test/' }, 'ses_2')).ok, true);
  tools.chrome.allowForConversation('ses_1');

  await tools.accountChanged();

  assert.deepEqual(driver.commands().at(-1), { session: null, command: ['close', '--all'] });
  assert.equal(chromeApprovals.record.forgotAll, 1);
  chromeApprovals.isApproved = async () => false;
  assert.equal(await tools.chrome.isHostAllowed('ses_1', 'acme.example.test'), false);
});

test('dispose closes every Chrome within 3 seconds even when the driver hangs', async (t) => {
  const driver = stubAgentBrowser(t, { hang: ['close'] });
  const { tools } = await chromeSetUp(t, { driver });
  const started = Date.now();
  await tools.dispose();
  const elapsed = Date.now() - started;
  assert.equal(CHROME_CLOSE_TIMEOUT_MS, 3_000);
  assert.ok(elapsed >= CHROME_CLOSE_TIMEOUT_MS - 100 && elapsed < CHROME_CLOSE_TIMEOUT_MS + 1_500, `dispose took ${elapsed} ms`);
  assert.deepEqual(driver.commands().map(({ command }) => command), [['close', '--all'], ['close', '--all']], 'the start-up sweep and the dispose');
  const again = Date.now();
  await tools.dispose();
  assert.ok(Date.now() - again < 500, 'a second dispose does not close again');
});

test('a Chrome left by an earlier run is closed at start, so its old profile or mode is never reused', async (t) => {
  const driver = stubAgentBrowser(t, { running: { [chromeSessionName('ses_1')]: 'http://acme.example.test/' } });
  const { chrome, mittrSettings } = await chromeSetUp(t, { driver });
  await mittrSettings.update({ tools: { chromeProfile: 'Default', chromeHeaded: false } });
  assert.deepEqual((await chrome('read')).error, { message: 'No page is open in this session; call chrome.open first', kind: 'usage' });
  const commands = driver.commands().map(({ command }) => command.join(' '));
  assert.equal(commands[0], 'close --all', 'the sweep runs before any Chrome action');
  assert.equal(commands.includes('get url'), false, 'the earlier run\'s Chrome was not asked for its page');
  assert.equal((await chrome('open', { url: 'http://acme.example.test/' })).ok, true);
});

const fakeEngineServer = async (t, { effect = 'ask' } = {}) => {
  const seen = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    seen.push({ method: req.method, path: req.path, body: req.body, auth: req.get('authorization') ?? null });
    next();
  });
  app.post('/api/session/:id/permission', (_req, res) => res.json({ data: effect === 'ask' ? { id: 'per_1', effect } : { effect } }));
  app.post('/api/session/:id/permission/:pid/reply', (_req, res) => res.status(204).end());
  app.get('/api/session/:id/permission', (_req, res) => res.json({ data: [{ id: 'per_1' }] }));
  app.get('/api/permission/saved', (_req, res) => res.json({ data: [] }));
  return { base: await listen(t, app), seen };
};

const engineChromeSetUp = async (t, options = {}) => {
  const engine = await fakeEngineServer(t, options);
  const setup = await chromeSetUp(t, { engineBase: engine.base });
  return { ...setup, engine };
};

const realApprovals = async (t, options) => {
  const engine = await fakeEngineServer(t, options);
  const project = fs.realpathSync(tempDataDir(t));
  const driver = stubAgentBrowser(t, { png: MARKER_PNG });
  const setup = await setUp(t, { drivers: { ...ALL_DRIVERS, chrome: () => driver.file }, chromeApprovals: null, engineBase: engine.base, resolveSessionDirectory: async () => project });
  const chrome = (action, parameters = {}, extra = {}) => setup.call({ tool: 'mittrcraft_chrome', input: { action, parameters }, sessionID: 'ses_1', ...extra });
  return { ...setup, engine, driver, project, chrome };
};

test('an engine call for a site not yet allowed raises the engine\'s own question and waits for the person\'s raw reply', async (t) => {
  const { chrome, engine, emitRaw, driver, project } = await realApprovals(t);
  const opened = chrome('open', { url: 'http://acme.example.test/' }, { messageID: 'msg_1', callID: 'call_1' });
  await until(() => engine.seen.some(({ path: route }) => route === '/api/session/ses_1/permission'));
  assert.equal(driver.commands().some(({ command }) => command[0] === 'open'), false, 'nothing opens before the person answers');
  emitRaw({ type: 'permission.replied', data: { sessionID: 'ses_1', requestID: 'per_1', reply: 'once' } });
  const answer = await opened;
  assert.equal(answer.ok, true);
  const created = engine.seen.find(({ method, path: route }) => method === 'POST' && route === '/api/session/ses_1/permission');
  assert.deepEqual(created.body, {
    action: 'mittrcraft_chrome',
    resources: ['acme.example.test'],
    save: ['acme.example.test'],
    message: 'Allow the agent to use your Chrome sign-in on acme.example.test?',
    metadata: { host: 'acme.example.test' },
    source: { type: 'tool', messageID: 'msg_1', id: 'call_1' },
  });
  assert.equal(created.auth, 'Basic acme');
  assert.ok(project);
});

test('a translated reply alone decides nothing: only the raw reply carries the answer', async (t) => {
  const { chrome, engine, eventListeners, driver } = await realApprovals(t);
  const opened = chrome('open', { url: 'http://acme.example.test/' });
  await until(() => engine.seen.some(({ path: route }) => route === '/api/session/ses_1/permission'));
  for (const listener of eventListeners) listener({ payload: {}, translated: () => [{ type: 'permission.replied', properties: { sessionID: 'ses_1', requestID: 'per_1' } }] });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(driver.commands().some(({ command }) => command[0] === 'open'), false);
  for (const listener of eventListeners) listener({ payload: { type: 'permission.replied', data: { sessionID: 'ses_1', requestID: 'per_1', reply: 'reject' } }, translated: () => [] });
  assert.deepEqual((await opened).error, { message: 'The user did not allow using their Chrome sign-in on acme.example.test', kind: 'usage' });
});

test('an account switch withdraws an open Chrome question with a reject', async (t) => {
  const { chrome, engine, tools } = await realApprovals(t);
  const opened = chrome('open', { url: 'http://acme.example.test/' });
  await until(() => engine.seen.some(({ path: route }) => route === '/api/session/ses_1/permission'));
  await tools.accountChanged();
  assert.deepEqual((await opened).error, { message: 'Cancelled while waiting for the user', kind: 'usage' });
  assert.deepEqual(engine.seen.filter(({ path: route }) => route.endsWith('/reply')).map(({ path: route, body }) => [route, body]), [['/api/session/ses_1/permission/per_1/reply', { decision: 'reject' }]]);
});

test('a Chrome call over http from another machine raises no question', async (t) => {
  const { registry, engine } = await realApprovals(t);
  await assert.rejects(
    registry.execute('chrome.open', { url: 'http://acme.example.test/' }, { surface: 'http', sessionId: 'ses_1', scope: { local: false } }),
    (error) => error.statusCode === 403 && /can only be used from this machine/.test(error.message),
  );
  assert.deepEqual(engine.seen, []);
});

test('the plugin asks the engine to always ask about Chrome sites, only while the Chrome tool is in it', async (t) => {
  const { pluginSource, tools } = await engineChromeSetUp(t);
  await tools.managedConfig();
  assert.match(pluginSource(), /const ASK_ALWAYS = \["mittrcraft_chrome"\]/);
  await tools.applySwitches({ chrome: false });
  assert.doesNotMatch(pluginSource(), /ASK_ALWAYS/);
});

test('only the Chrome question is never answered automatically', async (t) => {
  const { tools } = await setUp(t);
  assert.equal(tools.neverAutoAnswer({ action: 'mittrcraft_chrome', resources: ['acme.example.test'] }), true);
  assert.equal(tools.neverAutoAnswer({ action: 'bash', resources: ['ls'] }), false);
});

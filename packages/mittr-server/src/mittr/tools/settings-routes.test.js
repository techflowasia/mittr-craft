import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { OPENCHAMBER_ALL_ACTIONS } from '../../../../web/server/lib/openchamber-control/actions.js';
import { SCREENSHOT_DIRECTORY, writeScreenshot } from '../../../../web/server/lib/openchamber-control/screenshots.js';
import { createMittrSettings } from '../mittr-settings.js';
import { serve, stubAgentBrowser, tempDataDir } from '../test-helpers.js';
import { CHROME_PERMISSION } from './chrome-approvals.js';
import { setupMittrTools } from './index.js';
import { createMittrActionRegistry } from './registry.js';

const quietLogger = () => {
  const lines = [];
  const record = (...args) => lines.push(args.join(' '));
  return { lines, log: record, warn: record, error: record };
};

const CHROME_APP = '/Applications/Acme Chrome.app/Contents/MacOS/Acme Chrome';

const engineStub = (saved = []) => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    calls.push({ method: init.method ?? 'GET', pathname, directory: init.headers?.['x-opencode-directory'] ?? null });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    if (pathname === '/api/permission/saved') return Response.json({ data: saved });
    return Response.json({ data: null });
  };
  return { calls, fetchImpl };
};

const setUp = async (t, {
  personalDesktop = true,
  computer = '/r/cua-driver/cua-driver',
  chrome = 'stub',
  chromeInstalled = true,
  profiles = [{ directory: 'Default', name: 'Person' }, { directory: 'Profile 1', name: 'Work' }],
  stored = null,
  saved = [],
  refresh = null,
} = {}) => {
  const dataDir = tempDataDir(t);
  if (stored) fs.writeFileSync(path.join(dataDir, 'mittr-settings.json'), JSON.stringify(stored));
  const driver = stubAgentBrowser(t, { profiles });
  const engine = engineStub(saved);
  const logger = quietLogger();
  const app = express();
  const context = {
    app,
    express,
    dataDir,
    server: { port: () => 4100 },
    opencode: {
      url: (route = '/') => `http://127.0.0.1:4096${route}`,
      authHeaders: () => ({ authorization: 'Basic acme' }),
      defaultDirectory: () => '/work',
      onReady: () => () => {},
    },
    events: { subscribe: () => () => {} },
    settings: { read: async () => ({}) },
    control: { resolveSessionDirectory: async (id) => `/work/${id}`, writeScreenshot, SCREENSHOT_DIRECTORY },
  };
  const mittrSettings = createMittrSettings({ dataDir, logger });
  const state = { refreshes: 0 };
  let tools = null;
  tools = setupMittrTools(context, {
    registry: createMittrActionRegistry({ control: { all: OPENCHAMBER_ALL_ACTIONS, execute: async () => ({}) } }),
    mittrSettings,
    signedIn: () => true,
    personalDesktop: () => personalDesktop,
    refresh: async () => {
      state.refreshes += 1;
      if (refresh) await refresh();
      await tools.managedConfig();
    },
    drivers: {
      computer: () => computer,
      chrome: () => (chrome === 'stub' ? driver.file : chrome),
      chromePath: () => (chromeInstalled ? CHROME_APP : null),
    },
    engineFetch: engine.fetchImpl,
    platform: {},
    logger,
  });
  t.after(() => tools.dispose());
  const call = await serve(t, app);
  const settingsFile = path.join(dataDir, 'mittr-settings.json');
  const storedTools = () => (fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')).tools : undefined);
  const pluginTools = () => {
    const file = path.join(dataDir, 'engine-plugins', 'mittrcraft-tools', 'index.js');
    return fs.existsSync(file) ? [...fs.readFileSync(file, 'utf8').matchAll(/name: "(mittrcraft_[a-z]+)"/g)].map((match) => match[1]) : [];
  };
  return { call, state, driver, engine, logger, settingsFile, storedTools, pluginTools, tools };
};

const OFFERED = {
  computer: { offered: true, enabled: true },
  chrome: { offered: true, chromeInstalled: true, enabled: true, profile: null, headed: false, approvedHosts: [] },
};

const NOT_OFFERED_CHROME = { offered: false, chromeInstalled: false, enabled: true, profile: null, headed: false, approvedHosts: [] };

test('GET lists what this install offers', async (t) => {
  assert.deepEqual(await (await setUp(t)).call('GET', '/api/mittr/tools'), { status: 200, body: OFFERED });

  const hosted = await setUp(t, { personalDesktop: false, stored: { tools: { chromeProfile: 'Default', chromeApprovedHosts: ['jira.acme.test'] } } });
  assert.deepEqual((await hosted.call('GET', '/api/mittr/tools')).body, { computer: { offered: false, enabled: true }, chrome: NOT_OFFERED_CHROME });

  const noDrivers = await setUp(t, { computer: null, chrome: null });
  assert.deepEqual((await noDrivers.call('GET', '/api/mittr/tools')).body, { computer: { offered: false, enabled: true }, chrome: NOT_OFFERED_CHROME });

  const noChrome = await setUp(t, { chromeInstalled: false });
  assert.deepEqual((await noChrome.call('GET', '/api/mittr/tools')).body.chrome, { ...OFFERED.chrome, chromeInstalled: false });

  const stored = await setUp(t, { stored: { tools: { computer: false, chromeProfile: 'Profile 1', chromeHeaded: true, chromeApprovedHosts: ['jira.acme.test'] } } });
  assert.deepEqual((await stored.call('GET', '/api/mittr/tools')).body, {
    computer: { offered: true, enabled: false },
    chrome: { ...OFFERED.chrome, profile: 'Profile 1', headed: true, approvedHosts: ['jira.acme.test'] },
  });
});

test('PUT changes a switch and refreshes the tools', async (t) => {
  const { call, state, storedTools, pluginTools } = await setUp(t);

  const answer = await call('PUT', '/api/mittr/tools', { chrome: false, chromeHeaded: true });

  assert.deepEqual(answer, { status: 200, body: { ...OFFERED, chrome: { ...OFFERED.chrome, enabled: false, headed: true } } });
  assert.equal(state.refreshes, 1);
  assert.equal(storedTools().chrome, false);
  assert.equal(storedTools().chromeHeaded, true);
  assert.deepEqual(pluginTools(), ['mittrcraft_computer']);

  assert.deepEqual((await call('PUT', '/api/mittr/tools', { computer: false, chrome: true })).body.computer, { offered: true, enabled: false });
  assert.deepEqual(pluginTools(), ['mittrcraft_chrome']);
  assert.equal(state.refreshes, 2);
});

test('PUT stores a profile only when this Mac\'s Chrome lists it', async (t) => {
  const { call, storedTools, driver } = await setUp(t);

  assert.equal((await call('PUT', '/api/mittr/tools', { chromeProfile: 'Profile 1' })).body.chrome.profile, 'Profile 1');
  assert.equal(storedTools().chromeProfile, 'Profile 1');

  assert.deepEqual(await call('PUT', '/api/mittr/tools', { chromeProfile: 'Profile 9' }), { status: 400, body: { error: 'Unknown or invalid tool setting: chromeProfile' } });
  assert.equal(storedTools().chromeProfile, 'Profile 1');
  assert.ok(driver.commands().filter(({ command }) => command[0] === 'profiles').length >= 2);
});

test('an unknown key answers 400 and stores nothing', async (t) => {
  const { call, state, settingsFile } = await setUp(t);
  for (const [body, error] of [
    [{ chromeApprovedHosts: ['jira.acme.test'] }, 'Unknown or invalid tool setting: chromeApprovedHosts'],
    [{ allowForConversation: 'ses_1' }, 'Unknown or invalid tool setting: allowForConversation'],
    [{ computer: 'yes' }, 'Unknown or invalid tool setting: computer'],
    [{ chrome: null }, 'Unknown or invalid tool setting: chrome'],
    [{ chromeHeaded: 1 }, 'Unknown or invalid tool setting: chromeHeaded'],
    [{ chromeProfile: null }, 'Unknown or invalid tool setting: chromeProfile'],
    [{ chromeProfile: ' Default' }, 'Unknown or invalid tool setting: chromeProfile'],
    [{ chrome: true, chromeProfile: '..' }, 'Unknown or invalid tool setting: chromeProfile'],
    [{ chromeProfile: '~' }, 'Unknown or invalid tool setting: chromeProfile'],
    [{ chromeProfile: '--headed' }, 'Unknown or invalid tool setting: chromeProfile'],
    [{}, 'Give at least one tool setting'],
    [[true], 'Give at least one tool setting'],
  ]) {
    assert.deepEqual(await call('PUT', '/api/mittr/tools', body), { status: 400, body: { error } }, JSON.stringify(body));
  }
  const oversized = await fetch(`${call.base}/api/mittr/tools`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chrome: true, pad: 'x'.repeat(9 * 1024) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal(fs.existsSync(settingsFile), false);
  assert.equal(state.refreshes, 0);
});

test('a setting saved but not given to agents answers 500 with what is stored', async (t) => {
  const { call, storedTools, logger } = await setUp(t, { refresh: async () => { throw new Error('engine config busy'); } });

  const answer = await call('PUT', '/api/mittr/tools', { computer: false });

  assert.equal(answer.status, 500);
  assert.equal(answer.body.error, 'The tool setting is saved, but agents have not been given it yet');
  assert.deepEqual(answer.body.computer, { offered: true, enabled: false });
  assert.equal(storedTools().computer, false);
  assert.ok(logger.lines.some((line) => line.includes('was saved but not given to agents')));
});

test('GET profiles lists this Mac\'s Chrome profiles by folder and name only', async (t) => {
  const { call } = await setUp(t, {
    profiles: [
      { directory: 'Default', name: 'Person', email: 'person@acme.test' },
      { directory: 'Profile 1', name: '' },
      { directory: '/tmp/elsewhere', name: 'Odd' },
      { directory: '..', name: 'Up' },
      { name: 'No folder' },
      'Default',
    ],
  });
  assert.deepEqual(await call('GET', '/api/mittr/tools/chrome/profiles'), {
    status: 200,
    body: { profiles: [{ directory: 'Default', name: 'Person' }, { directory: 'Profile 1', name: 'Profile 1' }] },
  });

  const hosted = await setUp(t, { personalDesktop: false });
  assert.deepEqual(await hosted.call('GET', '/api/mittr/tools/chrome/profiles'), { status: 503, body: { error: 'The Chrome tool is not available in this install' } });
  assert.deepEqual(hosted.driver.commands().filter(({ command }) => command[0] === 'profiles'), []);
});

test('removing a site answers the remaining list', async (t) => {
  const { call, storedTools, engine } = await setUp(t, {
    stored: { tools: { chromeApprovedHosts: ['jira.acme.test', 'plane.acme.test'] } },
    saved: [
      { id: 'rule_jira', action: CHROME_PERMISSION, resource: 'jira.acme.test' },
      { id: 'rule_plane', action: CHROME_PERMISSION, resource: 'plane.acme.test' },
    ],
  });

  assert.deepEqual(await call('DELETE', '/api/mittr/tools/chrome/approved-hosts/JIRA.acme.test'), { status: 200, body: { hosts: ['plane.acme.test'] } });

  assert.deepEqual(storedTools().chromeApprovedHosts, ['plane.acme.test']);
  assert.deepEqual(engine.calls.filter(({ method }) => method === 'DELETE').map(({ pathname }) => pathname), ['/api/permission/saved/rule_jira']);
  assert.deepEqual((await call('GET', '/api/mittr/tools')).body.chrome.approvedHosts, ['plane.acme.test']);

  assert.deepEqual(await call('DELETE', '/api/mittr/tools/chrome/approved-hosts/a%20b'), { status: 400, body: { error: 'That is not a site name' } });
  const hosted = await setUp(t, { personalDesktop: false, stored: { tools: { chromeApprovedHosts: ['jira.acme.test'] } } });
  assert.equal((await hosted.call('DELETE', '/api/mittr/tools/chrome/approved-hosts/jira.acme.test')).status, 503);
});

test('no route offers a grant for one conversation', async (t) => {
  const { call } = await setUp(t);
  for (const [method, route] of [['POST', '/api/mittr/tools/chrome/conversation-grants'], ['PUT', '/api/mittr/tools/chrome/approved-hosts/jira.acme.test']]) {
    const response = await fetch(call.base + route, { method, headers: { 'content-type': 'application/json' }, body: '{"sessionId":"ses_1"}' });
    assert.equal(response.status, 404, `${method} ${route}`);
  }
});

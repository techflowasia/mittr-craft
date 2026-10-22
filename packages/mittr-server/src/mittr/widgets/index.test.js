import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import express from 'express';

import { OPENCHAMBER_ALL_ACTIONS } from '../../../../web/server/lib/openchamber-control/actions.js';
import { SCREENSHOT_DIRECTORY, writeScreenshot } from '../../../../web/server/lib/openchamber-control/screenshots.js';
import { createMittrSettings } from '../mittr-settings.js';
import { deferred, listen, serve, tempDataDir, until } from '../test-helpers.js';
import { registerMittrControlRoutes } from '../tools/control-routes.js';
import { setupMittrTools } from '../tools/index.js';
import { MITTR_TOOLS, createMittrActionRegistry } from '../tools/registry.js';
import { notifyThroughServer, setupMittrWidgets } from './index.js';

const ALICE = 'a1a1a1a1a1a1a1a1';
const BOB = 'b2b2b2b2b2b2b2b2';
const quiet = { log: () => {}, warn: () => {}, error: () => {} };

const setUp = async (t, { host = {}, personalDesktop = true, hold = null } = {}) => {
  const dataDir = tempDataDir(t);
  const project = fs.realpathSync(tempDataDir(t));
  const app = express();
  const registry = createMittrActionRegistry({ control: { all: OPENCHAMBER_ALL_ACTIONS, execute: async () => ({}) } });
  const context = {
    app,
    express,
    host,
    requestScope: () => 'local',
    dataDir,
    server: { port: () => 4100 },
    opencode: { url: (route = '/') => `http://127.0.0.1:4096${route}`, defaultDirectory: () => '/work', onReady: () => () => {} },
    events: { subscribe: () => () => {} },
    settings: { read: async () => ({}) },
    control: { resolveSessionDirectory: async () => null, writeScreenshot, SCREENSHOT_DIRECTORY },
  };
  const mittrSettings = createMittrSettings({ dataDir, logger: quiet });
  const tools = setupMittrTools(context, {
    registry,
    mittrSettings,
    signedIn: () => true,
    personalDesktop: () => personalDesktop,
    refresh: async () => {},
    drivers: { computer: () => null, chrome: () => null, chromePath: () => null },
    platform: {},
    logger: quiet,
  });
  t.after(() => tools.dispose());
  registerMittrControlRoutes(app, { express, registry, host, requestScope: () => 'local' });
  const state = { key: ALICE, runs: [] };
  const widgets = setupMittrWidgets(context, {
    registry,
    mittrSettings,
    tools,
    activeAccountKey: () => state.key,
    engineOnActiveHome: () => true,
    personalDesktop: () => personalDesktop,
    sources: {
      command: (source, { signal }) => {
        state.runs.push({ source, signal });
        return hold ? new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('The command was stopped')), { once: true });
          hold.promise.then(resolve);
        }) : Promise.resolve({ text: 'state=ok' });
      },
    },
    logger: quiet,
  });
  t.after(() => widgets.dispose());
  const call = await serve(t, app);
  const create = (key = ALICE) => {
    state.key = key;
    return registry.execute('widget.create', { title: 'Dev build', display: 'status', source: { type: 'command', command: 'cat status.txt', cwd: project, extract: { regex: 'state=(\\w+)' } } }, { surface: 'agent', tool: MITTR_TOOLS.widgets });
  };
  return { call, registry, tools, widgets, state, create, project };
};

test('a hosted runtime, or one that is not a personal desktop, registers no widget route and no widget action', async (t) => {
  for (const options of [{ host: null }, { personalDesktop: false }]) {
    const { call, registry, tools } = await setUp(t, options);
    for (const [method, route] of [['GET', '/api/mittr/widgets'], ['POST', '/api/mittr/widgets/wid_1/enable'], ['POST', '/api/mittr/widgets/wid_1/refresh'], ['DELETE', '/api/mittr/widgets/wid_1']]) {
      assert.equal((await fetch(call.base + route, { method })).status, 404, `${JSON.stringify(options)} ${method} ${route}`);
    }
    assert.equal(registry.has('widget.create'), false);
    assert.doesNotMatch(await tools.signature(), /mittrcraft_widgets/);
  }
});

test('agents get the widgets tool while its switch is on, and lose it when it goes off', async (t) => {
  const { tools } = await setUp(t);
  assert.match(await tools.signature(), /name: "mittrcraft_widgets"/);
  await tools.applySwitches({ widgets: false });
  assert.doesNotMatch(await tools.signature(), /mittrcraft_widgets/);
});

test('Review Focus 2: Mittr changes the command of a widget the person turned on, and nothing runs until the person turns it on again', async (t) => {
  const { call, registry, widgets, state, create, project } = await setUp(t);
  const { widget } = await create();
  assert.equal((await call('POST', `/api/mittr/widgets/${widget.id}/enable`)).body.widget.enabled, true);
  await until(() => state.runs.length === 1);

  await registry.execute('widget.update', { id: widget.id, source: { type: 'command', command: 'cat other.txt', cwd: project } }, { surface: 'agent', tool: MITTR_TOOLS.widgets });
  const listed = (await call('GET', '/api/mittr/widgets')).body.widgets;
  assert.equal(listed[0].enabled, false);
  assert.equal(listed[0].source.command, 'cat other.txt');

  await widgets.runner.tick();
  assert.equal((await call('POST', `/api/mittr/widgets/${widget.id}/refresh`)).status, 409);
  assert.equal(state.runs.length, 1);

  await call('POST', `/api/mittr/widgets/${widget.id}/enable`);
  await until(() => state.runs.length === 2);
  assert.equal(state.runs[1].source.command, 'cat other.txt');
});

test('turning the widgets switch off stops what is running', async (t) => {
  const hold = deferred();
  const { call, tools, state, create } = await setUp(t, { hold });
  const { widget } = await create();
  await call('POST', `/api/mittr/widgets/${widget.id}/enable`);
  await until(() => state.runs.length === 1);

  await tools.applySwitches({ widgets: false });

  assert.equal(state.runs[0].signal.aborted, true);
  hold.resolve({ text: 'state=ok' });
  assert.equal((await call('GET', '/api/mittr/widgets')).body.widgets[0].last, undefined);
});

test('an account switch stops that account\'s widgets', async (t) => {
  const hold = deferred();
  const { call, widgets, state, create } = await setUp(t, { hold });
  const { widget } = await create();
  await call('POST', `/api/mittr/widgets/${widget.id}/enable`);
  await until(() => state.runs.length === 1);

  widgets.accountChanged();
  state.key = BOB;

  assert.equal(state.runs[0].signal.aborted, true);
  await widgets.runner.tick();
  assert.equal(state.runs.length, 1);
  assert.deepEqual((await call('GET', '/api/mittr/widgets')).body.widgets, []);
});

test('an alert goes out through the server\'s own notification route on this Mac', async (t) => {
  const seen = [];
  const base = await listen(t, (req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], body: JSON.parse(body) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ delivered: true }));
    });
  });
  const notify = notifyThroughServer({ port: () => Number(new URL(base).port) });
  const widget = { id: 'wid_1', title: 'Gold price', display: 'number', alert: { op: 'below', value: 11_500 }, last: { at: 1, value: 11_320 } };

  assert.equal(await notify(widget), true);
  assert.deepEqual(seen, [{
    method: 'POST',
    url: '/api/notifications/emit',
    type: 'application/json',
    body: { title: 'Gold price', body: 'Now 11320, below 11500', tag: 'mittr-widget-wid_1' },
  }]);
  assert.equal(await notifyThroughServer({ port: () => null })(widget), false);
});

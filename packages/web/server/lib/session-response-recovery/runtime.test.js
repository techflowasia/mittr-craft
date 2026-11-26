import { describe, expect, it } from 'vitest';
import { createSessionResponseRecoveryRuntime } from './runtime.js';
import { createResponseRecoveryStore } from './store.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const limit = { type: 'provider', message: 'Length', response: { body: '{"error":{"code":"response_length_limit"}}' } };
const event = (type, seq, data = {}) => ({ id: `evt_${type}_${seq}`, type, durable: { aggregateID: 'ses_1', seq, version: 1 }, data: { sessionID: 'ses_1', ...data } });
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const eventually = async predicate => { for (let n = 0; n < 100 && !predicate(); n++) await new Promise(r => setTimeout(r, 1)); expect(predicate()).toBe(true); };
async function fixture(overrides = {}) {
  const store = await createResponseRecoveryStore({ filePath: path.join(await mkdtemp(path.join(tmpdir(), 'recovery-runtime-')), 'journal.json') });
  let identity = { owner: 'owner', generation: 1, account: 'account' };
  const messages = [ { id: 'msg_failed', type: 'assistant', error: limit }, { id: 'msg_human', type: 'user', text: 'Do the work' } ];
  const mutations = []; let runtime; let seq = 11;
  const emit = (type, data) => runtime.processEvent(event(type, seq++, data));
  const client = {
    session: {
      get: async () => ({ id: 'ses_1', location: { directory: '/project' }, model: { providerID: 'proof', id: 'proof' }, agent: 'build', time: {} }),
      active: async () => ({}),
      inbox: { list: async () => [], cancel: async input => { mutations.push(['cancel', input]); } },
      form: { list: async () => [] },
      compact: async input => { mutations.push(['compact', input]); throw new Error('Forced compaction is not approved'); },
      prompt: async input => {
        mutations.push(['prompt', input]);
        messages.unshift({ id: input.id, type: 'user', text: input.text, metadata: input.metadata });
        emit('session.execution.started'); emit('session.inbox.delivered', { inboxID: input.id }); emit('session.execution.succeeded');
        return { id: input.id, sessionID: 'ses_1', type: 'user', delivery: 'queue', payload: { text: input.text }, time: { created: 1 } };
      },
      interrupt: async input => { mutations.push(['interrupt', input]); },
    },
    message: { list: async () => ({ data: messages, cursor: {} }) },
    permission: { request: { list: async () => ({ data: [] }) } },
  };
  const deps = { store, getIdentity: () => identity, client: () => client,
    readGuard: async () => ({ known: true, archived: false, deleted: false, liveChildren: false }),
    ...overrides };
  runtime = createSessionResponseRecoveryRuntime(deps);
  return { runtime, client, messages, mutations, store, emit, identity: value => { identity = value; }, start: () => runtime.processEvent(event('session.execution.failed', 10, { error: limit })) };
}

describe('one-shot response recovery owner', () => {
  it.each([false, true])('passes legacy archive state to the authoritative guard, effective archived=%s', async archived => {
    const stamps = [];
    const f = await fixture({ readGuard: async (_id, _directory, _options, _api, upstreamArchived) => {
      stamps.push(upstreamArchived);
      return { known: true, archived, deleted: false, liveChildren: false };
    } });
    const get = f.client.session.get;
    f.client.session.get = async () => ({ ...await get(), time: { archived: 500 } });
    try {
      await f.start();
      expect(stamps.length).toBeGreaterThan(0);
      expect(stamps.every(stamp => stamp === 500)).toBe(true);
      expect(f.mutations.filter(([type]) => type === 'prompt')).toHaveLength(archived ? 0 : 1);
    } finally { await f.runtime.stop(); }
  });

  it('bounds shutdown flush after a real journal write outlives the transaction deadline', async () => {
    const held = deferred(); const timers = []; let writing = false;
    const store = await createResponseRecoveryStore({
      filePath: path.join(await mkdtemp(path.join(tmpdir(), 'recovery-stop-')), 'journal.json'),
      writeFile: async (...args) => { writing = true; await held.promise; return writeFile(...args); },
    });
    const f = await fixture({ store, setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
    const work = f.start(); await eventually(() => writing);
    timers[0](); await work;
    let outcome = 'pending';
    const stopping = f.runtime.stop().then(() => { outcome = 'flushed'; }, () => { outcome = 'failed'; });
    await eventually(() => timers.length === 2);
    timers[1](); await eventually(() => outcome !== 'pending'); await stopping;
    expect(outcome).toBe('failed');
    expect(store.available()).toBe(false);
    expect(f.mutations).toHaveLength(0);
    held.resolve(); await store.flush();
    expect(store.available()).toBe(false);
    await expect(store.put(store.list()[0])).rejects.toThrow('Recovery journal unavailable');
  });
  it('cleans up admission that happens after the first cancellation has finished', async () => {
    const f = await fixture(); const admit = deferred(); let queued = false;
    f.client.session.prompt = async input => {
      f.mutations.push(['prompt', input]); await admit.promise; queued = true;
      return { id: input.id, sessionID: 'ses_1', type: 'user' };
    };
    f.client.session.inbox.cancel = async input => { queued = false; f.mutations.push(['cancel', input]); };
    const work = f.start(); await eventually(() => f.mutations.length === 1);
    let finished = false;
    const cancellation = f.runtime.cancelSession('ses_1', 'stop').then(() => { finished = true; });
    await eventually(() => f.mutations.some(item => item[0] === 'interrupt'));
    expect(f.runtime.isReserved('ses_1')).toBe(true);
    expect(finished).toBe(false);
    admit.resolve(); await cancellation; await work;
    expect(queued).toBe(false);
    expect(f.mutations.filter(item => item[0] === 'cancel')).toHaveLength(2);
    expect(f.runtime.isReserved('ses_1')).toBe(false);
  });
  it('holds the reservation until session-wide interruption settles', async () => {
    const f = await fixture(); const interrupt = deferred();
    f.client.session.prompt = async input => { f.mutations.push(['prompt', input]); return { id: input.id, sessionID: 'ses_1', type: 'user' }; };
    f.client.session.interrupt = async input => { f.mutations.push(['interrupt', input]); await interrupt.promise; };
    const work = f.start(); await eventually(() => f.mutations.length === 1);
    const cancellation = f.runtime.cancelSession('ses_1');
    await eventually(() => f.mutations.some(item => item[0] === 'interrupt'));
    expect(f.runtime.isReserved('ses_1')).toBe(true);
    interrupt.resolve(); await cancellation; await work;
    expect(f.runtime.isReserved('ses_1')).toBe(false);
  });
  it.each(['initial', 'final'])('bounds a hung %s authoritative read', async boundary => {
    const timers = []; const f = await fixture({ setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
    const get = f.client.session.get; let reads = 0; let hung = false;
    f.client.session.get = async () => {
      reads++;
      if (boundary === 'initial' || reads === 3) { hung = true; return new Promise(() => {}); }
      return get();
    };
    let finished = false; const work = f.start().then(() => { finished = true; });
    await eventually(() => hung);
    expect(timers.length).toBeGreaterThan(0);
    timers[0](); await eventually(() => finished); await work;
    expect(f.runtime.isReserved('ses_1')).toBe(false);
    expect(f.mutations.filter(item => item[0] === 'prompt')).toHaveLength(boundary === 'initial' ? 0 : 1);
  });
  it('retains the fence after a lost admission response, even after another input event', async () => {
    const f = await fixture();
    f.client.session.prompt = async () => { throw Error('response lost after enqueue'); };
    await f.start();
    expect(f.runtime.isReserved('ses_1')).toBe(true);
    await f.runtime.cancelSession('ses_1');
    await f.emit('session.inbox.delivered', { inboxID: 'msg_other' });
    expect(f.runtime.isReserved('ses_1')).toBe(true);
    await f.runtime.stop();
  });
  it('finishes bounded cancellation but retains a fence for indefinitely unknown admission', async () => {
    const timers = []; const f = await fixture({ setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
    const admission = deferred(); let queued = false;
    f.client.session.prompt = async input => {
      f.mutations.push(['prompt', input]); await admission.promise; queued = true;
      return { id: input.id, sessionID: 'ses_1', type: 'user' };
    };
    f.client.session.inbox.cancel = async input => { queued = false; f.mutations.push(['cancel', input]); };
    const work = f.start(); await eventually(() => f.mutations.length === 1);
    const cancelled = f.runtime.cancelSession('ses_1');
    await eventually(() => f.mutations.some(item => item[0] === 'interrupt'));
    timers[0](); await cancelled; await work;
    expect(f.runtime.isReserved('ses_1')).toBe(true);
    admission.resolve(); await eventually(() => f.mutations.filter(item => item[0] === 'cancel').length === 2);
    expect(queued).toBe(false);
    expect(f.runtime.isReserved('ses_1')).toBe(true);
    await f.runtime.stop();
  });
  it('accepts a terminal null message cursor from the V2 engine', async () => {
    const f = await fixture();
    f.client.message.list = async () => ({ data: f.messages, cursor: { previous: null, next: null } });
    await f.start();
    expect(f.mutations.map(item => item[0])).toEqual(['prompt']);
    expect(f.runtime.snapshot('ses_1').phase).toBe('succeeded');
  });
  it('does not restart a cancelled attempt on a later terminal failure', async () => {
    const f = await fixture(); const pending = deferred(); const get = f.client.session.get;
    f.client.session.get = () => pending.promise;
    const work = f.runtime.processEvent(event('session.step.failed', 9, { assistantMessageID: 'msg_failed', error: limit }));
    await f.runtime.cancelSession('ses_1', 'stop');
    f.client.session.get = get; pending.resolve(await get()); await work;
    await f.start();
    expect(f.mutations).toHaveLength(0);
  });
  it('reserves synchronously, consumes before admission, and completes once despite duplicate failures', async () => {
    const f = await fixture();
    const work = f.start();
    expect(f.runtime.isReserved('ses_1')).toBe(true);
    f.start(); f.runtime.processEvent(event('session.step.failed', 9, { assistantMessageID: 'msg_failed', error: limit }));
    await work;
    expect(f.mutations.map(x => x[0])).toEqual(['prompt']);
    expect(f.runtime.snapshot('ses_1').phase).toBe('succeeded');
    expect(f.runtime.isReserved('ses_1')).toBe(false);
    expect(f.mutations[0][1]).toMatchObject({ metadata: { openchamber: { responseRecovery: { originalHumanMessageID: 'msg_human' } } } });
    expect(f.mutations[0][1].text).not.toContain('Do the work');
    await f.start(); expect(f.mutations).toHaveLength(1);
  });
  it('keeps the original allowance consumed when continuation fails with a second length error', async () => {
    const f = await fixture();
    f.client.session.prompt = async input => {
      f.mutations.push(['prompt', input]);
      f.messages.unshift({ id: input.id, type: 'user', metadata: input.metadata });
      f.emit('session.execution.started'); f.emit('session.inbox.delivered', { inboxID: input.id }); f.emit('session.execution.failed', { error: limit });
      return { id: input.id, sessionID: 'ses_1', type: 'user' };
    };
    await f.start(); await f.start();
    expect(f.runtime.snapshot('ses_1').phase).toBe('failed');
    expect(f.mutations.map(x => x[0])).toEqual(['prompt']);
  });
  it('cancels a continuation admitted while Stop is racing its response', async () => {
    const pending = deferred(); const f = await fixture();
    f.client.session.prompt = async input => { f.mutations.push(['prompt', input]); return pending.promise; };
    const work = f.start(); await eventually(() => f.mutations.length === 1);
    const cancelled = f.runtime.cancelSession('ses_1', 'stop');
    pending.resolve({ id: f.mutations[0][1].id, sessionID: 'ses_1', type: 'user' });
    await cancelled; await work;
    expect(f.mutations.map(item => item[0])).toEqual(['prompt', 'cancel', 'interrupt', 'cancel', 'interrupt']);
    expect(f.runtime.snapshot('ses_1').phase).toBe('cancelled');
  });
  it.each(['unrelated-start', 'missing-delivery', 'sequence-gap', 'reversed-sequence'])('rejects ambiguous continuation settlement: %s', async mode => {
    const f = await fixture();
    f.client.session.prompt = async input => {
      f.mutations.push(['prompt', input]);
      f.emit('session.execution.started');
      if (mode === 'unrelated-start') f.emit('session.execution.started');
      if (mode !== 'missing-delivery') f.emit('session.inbox.delivered', { inboxID: input.id });
      if (mode === 'sequence-gap' || mode === 'reversed-sequence') f.runtime.processEvent(event('session.execution.succeeded', mode === 'sequence-gap' ? 30 : 9));
      else f.emit('session.execution.succeeded');
      return { id: input.id, sessionID: 'ses_1', type: 'user' };
    };
    await f.start(); await f.start();
    expect(f.runtime.snapshot('ses_1').phase).toBe('failed');
    expect(f.mutations.filter(item => item[0] === 'prompt')).toHaveLength(1);
  });
  it('uses one fixed deadline when no continuation completion arrives', async () => {
    const timers = []; const f = await fixture({ setTimer: (fn, ms) => { timers.push([fn, ms]); return 1; }, clearTimer: () => {} });
    f.client.session.prompt = async input => { f.mutations.push(['prompt', input]); return { id: input.id, type: 'user', sessionID: 'ses_1' }; };
    const work = f.start(); await eventually(() => f.mutations.length === 1);
    expect(timers.map(x => x[1])).toEqual([120000]); timers[0][0](); await work;
    expect(f.runtime.snapshot('ses_1').phase).toBe('failed');
    expect(f.mutations.filter(x => x[0] === 'prompt')).toHaveLength(1);
  });
  it.each(['permissions', 'forms', 'active', 'children', 'revert', 'unknown', 'pagination'])('fails closed before admission for %s', async mode => {
    const f = await fixture(mode === 'children' || mode === 'unknown' ? { readGuard: async () => ({ known: mode !== 'unknown', liveChildren: mode === 'children', archived: false, deleted: false }) } : {});
    if (mode === 'permissions') f.client.permission.request.list = async () => ({ data: [{ sessionID: 'ses_1' }] });
    if (mode === 'forms') f.client.session.form.list = async () => [{ status: 'pending' }];
    if (mode === 'active') f.client.session.active = async () => ({ ses_1: { type: 'running' } });
    if (mode === 'revert') { const get = f.client.session.get; f.client.session.get = async () => ({ ...await get(), revert: {} }); }
    if (mode === 'pagination') f.client.message.list = async () => ({ data: [{ id: 'msg_failed', type: 'assistant', error: limit }], cursor: { next: 'loop' } });
    await f.start(); expect(f.mutations).toHaveLength(0);
  });
  it('cancels at a pending fresh read and rejects its late completion', async () => {
    const pending = deferred(); const f = await fixture();
    f.client.session.get = () => pending.promise;
    const work = f.start(); f.runtime.cancelSession('ses_1', 'stop');
    pending.resolve({ id: 'ses_1', location: { directory: '/project' }, model: { providerID: 'proof', id: 'proof' }, agent: 'build', time: {} }); await work;
    expect(f.mutations).toHaveLength(0); expect(f.runtime.snapshot('ses_1').phase).toBe('cancelled');
  });
  it.each(['get', 'active', 'permissions', 'forms', 'inbox', 'history', 'guard', 'persist'])('new human cancels at awaited %s boundary', async boundary => {
    const hold = deferred(); const f = await fixture();
    if (boundary === 'get') { const original = f.client.session.get; f.client.session.get = async () => { await hold.promise; return original(); }; }
    if (boundary === 'active') f.client.session.active = async () => { await hold.promise; return {}; };
    if (boundary === 'permissions') f.client.permission.request.list = async () => { await hold.promise; return { data: [] }; };
    if (boundary === 'forms') f.client.session.form.list = async () => { await hold.promise; return []; };
    if (boundary === 'inbox') f.client.session.inbox.list = async () => { await hold.promise; return []; };
    if (boundary === 'history') f.client.message.list = async () => { await hold.promise; return { data: f.messages, cursor: {} }; };
    if (boundary === 'persist') { const original = f.store.put; f.store.put = async entry => { await hold.promise; return original(entry); }; }
    // Guard is independently injected and covered by unknown/children cases; pause the adjacent authoritative read here.
    if (boundary === 'guard') { const original = f.client.session.get; f.client.session.get = async () => { await hold.promise; return original(); }; }
    const work = f.start();
    await new Promise(resolve => setTimeout(resolve, 5));
    f.emit('session.inbox.enqueued', { inboxID: 'msg_new', item: { type: 'user', id: 'msg_new', payload: { text: 'new human' } } });
    hold.resolve(); await work;
    expect(f.mutations).toHaveLength(0);
  });
  it.each(['account', 'generation', 'model', 'agent', 'directory'])('checks fresh %s before continuation', async field => {
    const f = await fixture(); const put = f.store.put;
    f.store.put = async entry => {
      await put(entry);
      if (field === 'account' || field === 'generation') f.identity({ owner: 'owner', generation: field === 'generation' ? 2 : 1, account: field === 'account' ? 'other' : 'account' });
      else { const original = f.client.session.get; f.client.session.get = async () => { const value = await original(); if (field === 'model') value.model.id = 'other'; if (field === 'agent') value.agent = 'other'; if (field === 'directory') value.location.directory = '/other'; return value; }; }
    };
    await f.start(); expect(f.mutations.filter(x => x[0] === 'prompt')).toHaveLength(0);
    expect(f.runtime.snapshot('ses_1').phase).toBe('failed');
  });
  it('does not confuse a compact execution success with the continuation result', async () => {
    const f = await fixture();
    f.client.session.prompt = async input => { f.mutations.push(['prompt', input]); f.emit('session.execution.succeeded'); return { id: input.id, sessionID: 'ses_1', type: 'user' }; };
    await f.start(); expect(f.runtime.snapshot('ses_1').phase).toBe('failed');
  });
  it('fails rather than admitting another continuation after a lost prompt response', async () => {
    const f = await fixture();
    f.client.session.prompt = async input => { f.mutations.push(['prompt', input]); throw Error('lost'); };
    await f.start(); await f.start();
    expect(f.mutations.filter(x => x[0] === 'prompt')).toHaveLength(1);
    expect(f.runtime.snapshot('ses_1').phase).toBe('failed');
  });
  it('blocks an older replay from spending the allowance of a newer human', async () => {
    const f = await fixture(); await f.start();
    f.messages.unshift({ id: 'msg_new', type: 'user', text: 'new task' });
    await f.start(); expect(f.mutations.filter(x => x[0] === 'prompt')).toHaveLength(1);
  });
  it('times out a hanging admission and cancels its captured inbox identity', async () => {
    const timers = []; const f = await fixture({ setTimer: fn => { timers.push(fn); return 1; }, clearTimer: () => {} });
    f.client.session.prompt = async input => { f.mutations.push(['prompt', input]); return new Promise(() => {}); };
    const work = f.start(); await eventually(() => f.mutations.length === 1);
    timers[0]();
    await work;
    expect(f.mutations.map(item => item[0])).toEqual(['prompt', 'cancel', 'interrupt']);
    await f.runtime.stop();
  });
  it('keeps the admission deadline after terminal success arrives first', async () => {
    const timers = []; const f = await fixture({ setTimer: fn => { timers.push(fn); return 1; }, clearTimer: () => {} });
    f.client.session.prompt = async input => {
      f.mutations.push(['prompt', input]);
      f.emit('session.execution.started'); f.emit('session.inbox.delivered', { inboxID: input.id }); f.emit('session.execution.succeeded');
      return new Promise(() => {});
    };
    const work = f.start(); await eventually(() => f.mutations.length === 1);
    timers[0](); await work;
    expect(f.runtime.snapshot('ses_1').phase).toBe('failed');
    await f.runtime.stop();
  });
  it('cancels a hanging read promptly rather than holding shutdown hostage', async () => {
    const f = await fixture(); f.client.session.get = () => new Promise(() => {});
    const work = f.start();
    f.runtime.cancelSession('ses_1', 'stop');
    await work;
    expect(f.runtime.isReserved('ses_1')).toBe(false);
    await f.runtime.stop();
  });
  it('waits for the execution failure after a step failure without a second allowance', async () => {
    const f = await fixture();
    const work = f.runtime.processEvent(event('session.step.failed', 9, { assistantMessageID: 'msg_failed', error: limit }));
    expect(f.runtime.isReserved('ses_1')).toBe(true);
    f.start(); await work;
    expect(f.mutations.map(item => item[0])).toEqual(['prompt']);
  });
  it('cancels on account events before any pending read returns', async () => {
    const f = await fixture(); const hold = deferred(); f.client.session.get = () => hold.promise;
    const work = f.start();
    f.runtime.processEvent({ id: 'evt_account', type: 'credential.switched', data: {} });
    await work; expect(f.mutations).toHaveLength(0);
  });
  it('sends nothing when journal persistence fails', async () => {
    const f = await fixture(); f.store.put = async () => { throw Error('disk'); };
    await f.start(); expect(f.mutations).toHaveLength(0); expect(f.runtime.isReserved('ses_1')).toBe(false);
  });
});

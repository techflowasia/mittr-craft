import { describe, expect, it } from 'vitest';
import http from 'node:http';
import express from 'express';
import { createOpenCodeClient } from '../openchamber-sessions/opencode-client.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createArchiveStore } from '../openchamber-sessions/archive-store.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createResponseRecoveryOwner } from './owner.js';

const limit = { type: 'provider', message: 'Length', response: { body: '{"error":{"code":"response_length_limit"}}' } };
const failure = { id: 'evt_fail', type: 'session.execution.failed', durable: { aggregateID: 'ses_1', seq: 10 }, data: { sessionID: 'ses_1', error: limit } };

describe('response recovery server owner', () => {
  it('admits one SDK continuation without compaction through loopback HTTP', async () => {
    const requests = []; let owner; let seq = 11;
    const messages = [{ id: 'msg_failed', type: 'assistant', error: limit }, { id: 'msg_human', type: 'user' }];
    const server = http.createServer(async (req, res) => {
      requests.push([req.method, req.url]);
      const send = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); };
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/session/active') return send({ data: {} });
      if (url.pathname === '/api/session') return send({ data: [], cursor: { previous: null, next: null } });
      if (url.pathname.endsWith('/message')) return send({ data: messages, cursor: {} });
      if (url.pathname.endsWith('/inbox') || url.pathname.endsWith('/form') || url.pathname === '/api/permission/request') return send({ data: [] });
      if (req.method === 'POST' && url.pathname.endsWith('/prompt')) {
        let body = ''; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body);
        messages.unshift({ id: input.id, type: 'user' });
        for (const [type, data] of [['session.execution.started', {}], ['session.inbox.delivered', { inboxID: input.id }], ['session.execution.failed', { error: limit }]]) {
          void owner.processEvent({ id: `evt_${seq}`, type, durable: { aggregateID: 'ses_1', seq: seq++ }, data: { sessionID: 'ses_1', ...data } });
        }
        return send({ data: { id: input.id, sessionID: 'ses_1', type: 'user' } });
      }
      return send({ data: { id: 'ses_1', location: { directory: '/project' }, model: { providerID: 'proof', id: 'proof' }, agent: 'build', time: {} } });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      owner = await createResponseRecoveryOwner({ dataDir: await mkdtemp(path.join(tmpdir(), 'recovery-http-')), namespace: 'managed',
        client: () => createOpenCodeClient({ baseUrl: `http://127.0.0.1:${server.address().port}` }),
        archiveStore: () => ({ load: async () => ({ ok: true, authoritative: true }), getAll: async () => ({}) }) });
      await owner.processEvent(failure);
      await owner.processEvent({ ...failure, id: 'evt_second', durable: { aggregateID: 'ses_1', seq: seq++ } });
      expect(requests.filter(([method]) => method === 'POST')).toEqual([['POST', '/api/session/ses_1/prompt']]);
      expect(owner.snapshot('ses_1').phase).toBe('failed');
    } finally { await owner?.stop(); await new Promise(resolve => server.close(resolve)); }
  });
  it('keeps a stopped-turn tombstone across same-account generation invalidation', async () => {
    let reads = 0;
    const api = { session: { get: () => { reads++; return new Promise(() => {}); } } };
    const owner = await createResponseRecoveryOwner({ dataDir: await mkdtemp(path.join(tmpdir(), 'recovery-generation-')), namespace: 'managed', client: () => api,
      archiveStore: () => ({ load: async () => ({ ok: true, authoritative: true }), getAll: async () => ({}) }) });
    try {
      const work = owner.processEvent(failure);
      await owner.invalidate(); await work;
      void owner.processEvent({ ...failure, id: 'late_generation', durable: { aggregateID: 'ses_1', seq: 11 } });
      expect(reads).toBe(1);
    } finally { await owner.stop(); }
  });
  it('an authenticated Stop HTTP request cancels before admission and routing', async () => {
    let prompts = 0;
    let owner;
    let readStarted;
    const started = new Promise(resolve => { readStarted = resolve; });
    const api = { session: { get: () => { readStarted(); return new Promise(() => {}); }, prompt: async () => { prompts++; } } };
    owner = await createResponseRecoveryOwner({ dataDir: await mkdtemp(path.join(tmpdir(), 'recovery-stop-http-')), namespace: 'managed', client: () => api,
      archiveStore: () => ({ load: async () => ({ ok: true, authoritative: true }), getAll: async () => ({}) }) });
    const app = express();
    app.use((req, res, next) => req.headers['x-test-authorized'] === 'yes' ? next() : res.sendStatus(401));
    app.use(owner.beforeRequest);
    app.post('/api/session/ses_1/interrupt', (_req, res) => res.json({ reserved: owner.isReserved('ses_1') }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const work = owner.processEvent(failure);
      await started;
      const url = `http://127.0.0.1:${server.address().port}/api/session/ses_1/interrupt`;
      expect((await fetch(url, { method: 'POST' })).status).toBe(401);
      expect(owner.isReserved('ses_1')).toBe(true);
      const response = await fetch(url, { method: 'POST', headers: { 'x-test-authorized': 'yes' } });
      expect(await response.json()).toEqual({ reserved: true });
      await work;
      expect(owner.isReserved('ses_1')).toBe(false);
      expect(prompts).toBe(0);
      await owner.processEvent({ ...failure, id: 'late_stop', durable: { aggregateID: 'ses_1', seq: 11 } });
      expect(prompts).toBe(0);
    } finally { await owner.stop(); await new Promise(resolve => server.close(resolve)); }
  });
  it('cancels synchronously before middleware yields to routing', async () => {
    const api = { session: { get: () => new Promise(() => {}) } };
    const owner = await createResponseRecoveryOwner({ dataDir: await mkdtemp(path.join(tmpdir(), 'recovery-request-')), namespace: 'managed', client: () => api,
      archiveStore: () => ({ load: async () => ({ ok: true, authoritative: true }), getAll: async () => ({}) }) });
    const work = owner.processEvent(failure);
    expect(owner.isReserved('ses_1')).toBe(true);
    let routed = false;
    const request = owner.beforeRequest({ method: 'POST', originalUrl: '/api/session/ses_1/prompt' }, null, () => { routed = true; });
    expect(owner.isReserved('ses_1')).toBe(true);
    expect(routed).toBe(false);
    await request; await work;
    expect(owner.isReserved('ses_1')).toBe(false);
    expect(routed).toBe(true);
    await owner.stop();
  });
  it.each([false, true])('refuses admission when archive load authority is %s', async ok => {
    let reads = 0;
    const api = { session: { get: async () => ({ id: 'ses_1', location: { directory: '/project' }, model: { providerID: 'proof', id: 'proof' }, agent: 'build', time: {} }), active: async () => { reads++; return {}; }, list: async () => ({ data: [], cursor: {} }) } };
    const owner = await createResponseRecoveryOwner({ dataDir: await mkdtemp(path.join(tmpdir(), 'recovery-archive-')), namespace: 'managed', client: () => api,
      archiveStore: () => ({ load: async () => ({ ok, authoritative: ok }), getAll: async () => ({ ses_1: 1000 }) }) });
    await owner.processEvent(failure);
    expect(owner.isReserved('ses_1')).toBe(false);
    expect(reads).toBe(ok ? 1 : 0);
    await owner.stop();
  });
  it.each(['unarchived', 'archived', 'load-failed', 'legacy-restored', 'legacy-no-override', 'corrupt', 'corrupt-quarantine-failed'])('uses the real async archive store guard for %s sessions', async state => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'recovery-real-archive-'));
    const archive = createArchiveStore({ dataDir, now: () => 1000 });
    const allowed = state === 'unarchived' || state === 'legacy-restored';
    if (state === 'legacy-restored') await writeFile(archive.filePath, '{"ses_1":null}');
    if (state.startsWith('corrupt')) {
      await writeFile(archive.filePath, '{"ses_1":1000');
      if (state === 'corrupt-quarantine-failed') await mkdir(`${archive.filePath}.corrupt-1000`);
    }
    if (state === 'archived') await writeFile(archive.filePath, '{"ses_1":1000}');
    // A directory at the file path produces a real read failure, not empty success.
    if (state === 'load-failed') await mkdir(archive.filePath);
    let prompts = 0;
    let owner;
    const api = {
      session: {
        get: async () => ({ id: 'ses_1', location: { directory: '/project' }, model: { providerID: 'proof', id: 'proof' }, agent: 'build', time: {} }),
        active: async () => ({}), list: async () => ({ data: [], cursor: { next: null } }),
        form: { list: async () => [] }, inbox: { list: async () => [], cancel: async () => {} }, interrupt: async () => {},
        prompt: async input => {
          prompts++;
          queueMicrotask(() => { void owner.processEvent({ ...failure, id: 'continuation-failed', durable: { aggregateID: 'ses_1', seq: 11 } }); });
          return { id: input.id, sessionID: input.sessionID, type: 'user' };
        },
      },
      permission: { request: { list: async () => ({ data: [] }) } },
      message: { list: async () => ({ data: [{ id: 'msg_failed', type: 'assistant', error: limit }, { id: 'msg_human', type: 'user' }], cursor: { next: null } }) },
    };
    if (state.startsWith('legacy')) {
      const get = api.session.get;
      api.session.get = async () => ({ ...await get(), time: { archived: 500 } });
    }
    owner = await createResponseRecoveryOwner({ dataDir, namespace: 'managed', client: () => api, archiveStore: () => archive });
    try {
      await owner.processEvent(failure);
      expect(prompts).toBe(allowed ? 1 : 0);
      await owner.processEvent({ ...failure, id: 'repeated-failure', durable: { aggregateID: 'ses_1', seq: 12 } });
      expect(prompts).toBe(allowed ? 1 : 0);
      expect(owner.isReserved('ses_1')).toBe(false);
      expect((await archive.load()).ok).toBe(state !== 'load-failed');
    } finally {
      await owner.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps guard reads on the transaction client even if the supplier changes', async () => {
    let supplied = 0;
    let capturedReads = 0;
    let otherReads = 0;
    const session = { id: 'ses_1', location: { directory: '/project' }, model: { providerID: 'proof', id: 'proof' }, agent: 'build', time: {} };
    const first = { session: { get: async () => session, active: async () => { capturedReads++; return {}; }, list: async () => ({ data: [], cursor: {} }) } };
    const other = { session: { active: async () => { otherReads++; return {}; }, list: async () => ({ data: [], cursor: {} }) } };
    const owner = await createResponseRecoveryOwner({ dataDir: await mkdtemp(path.join(tmpdir(), 'recovery-capture-')), namespace: 'managed',
      client: () => ++supplied === 1 ? first : other,
      archiveStore: () => ({ load: async () => ({ ok: true, authoritative: true }), getAll: async () => ({}) }) });
    try {
      await owner.processEvent(failure);
      expect(otherReads).toBe(0);
      expect(capturedReads).toBe(2);
      expect(supplied).toBe(1);
    } finally { await owner.stop(); }
  });
  it('keeps the parent filter on every child page', async () => {
    const inputs = [];
    const api = { session: {
      get: async () => ({ id: 'ses_1', location: { directory: '/project' }, model: { providerID: 'proof', id: 'proof' }, agent: 'build', time: {} }),
      active: async () => ({}),
      list: async input => { inputs.push(input); return input.cursor ? { data: [], cursor: {} } : { data: [], cursor: { next: 'page_2' } }; },
    } };
    const owner = await createResponseRecoveryOwner({ dataDir: await mkdtemp(path.join(tmpdir(), 'recovery-pages-')), namespace: 'managed', client: () => api,
      archiveStore: () => ({ load: async () => ({ ok: true, authoritative: true }), getAll: async () => ({}) }) });
    try {
      await owner.processEvent(failure);
      expect(inputs).toEqual([{ parentID: 'ses_1', limit: 100 }, { parentID: 'ses_1', limit: 100, cursor: 'page_2' }]);
    } finally { await owner.stop(); }
  });
  it.each(['account', 'upstream'])('isolates reused session IDs by durable %s, including after server recreation', async scope => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'recovery-accounts-'));
    let account = 'account-a';
    let prompts = 0;
    const api = {
      session: {
        get: async () => ({ id: 'ses_1', location: { directory: '/project' }, model: { providerID: 'proof', id: 'proof' }, agent: 'build', time: {} }),
        active: async () => ({}), list: async () => ({ data: [], cursor: {} }),
        form: { list: async () => [] }, inbox: { list: async () => [], cancel: async () => {} }, interrupt: async () => {},
        prompt: async input => {
          prompts++;
          queueMicrotask(() => { void owner.processEvent({ ...failure, id: `terminal-${prompts}`, durable: { aggregateID: 'ses_1', seq: 11 } }); });
          return { id: input.id, sessionID: input.sessionID, type: 'user' };
        },
      },
      permission: { request: { list: async () => ({ data: [] }) } },
      message: { list: async () => ({ data: [{ id: 'msg_failed', type: 'assistant', error: limit }, { id: 'msg_human', type: 'user' }], cursor: {} }) },
    };
    const options = { dataDir, getNamespace: () => scope === 'upstream' ? account : 'managed', account: () => scope === 'account' ? account : 'same-account', client: () => api,
      archiveStore: () => ({ load: async () => ({ ok: true, authoritative: true }), getAll: async () => ({}) }) };
    let owner = await createResponseRecoveryOwner(options);
    try {
      await owner.processEvent(failure);
      expect(prompts).toBe(1);
      await owner.invalidate(); account = 'account-b';
      await owner.processEvent(failure);
      expect(prompts).toBe(2);
      await owner.invalidate(); account = 'account-a';
      await owner.processEvent({ ...failure, durable: { aggregateID: 'ses_1', seq: 20 } });
      expect(prompts).toBe(2);
      await owner.stop();
      owner = await createResponseRecoveryOwner(options);
      await owner.processEvent({ ...failure, durable: { aggregateID: 'ses_1', seq: 30 } });
      expect(prompts).toBe(2);
      await owner.invalidate(); account = 'account-b';
      await owner.processEvent({ ...failure, durable: { aggregateID: 'ses_1', seq: 30 } });
      expect(prompts).toBe(2);
    } finally { await owner.stop(); }
  });
  it('routes Stop immediately while captured recovery admission and cleanup remain pending', async () => {
    let admitted;
    const admission = new Promise(resolve => { admitted = resolve; });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const api = {
      session: {
        get: async () => ({ id: 'ses_1', location: { directory: '/project' }, model: { providerID: 'proof', id: 'proof' }, agent: 'build', time: {} }),
        active: async () => ({}), list: async () => ({ data: [], cursor: {} }),
        form: { list: async () => [] }, inbox: { list: async () => [], cancel: async () => { await held; } }, interrupt: async () => { await held; },
        prompt: async input => { admitted(); await held; return { id: input.id, sessionID: input.sessionID, type: 'user' }; },
      },
      permission: { request: { list: async () => ({ data: [] }) } },
      message: { list: async () => ({ data: [{ id: 'msg_failed', type: 'assistant', error: limit }, { id: 'msg_human', type: 'user' }], cursor: {} }) },
    };
    const owner = await createResponseRecoveryOwner({ dataDir: await mkdtemp(path.join(tmpdir(), 'recovery-stop-cleanup-')), namespace: 'managed', client: () => api,
      archiveStore: () => ({ load: async () => ({ ok: true, authoritative: true }), getAll: async () => ({}) }) });
    const work = owner.processEvent(failure);
    try {
      await admission;
      let routed = false;
      await owner.beforeRequest({ method: 'POST', originalUrl: '/api/session/ses_1/interrupt' }, null, () => { routed = true; });
      expect(routed).toBe(true);
      expect(owner.isReserved('ses_1')).toBe(true);
    } finally { release(); await work; await owner.stop(); }
  });

  it('blocks routing and account mutation after an uncertain continuation admission', async () => {
    const api = {
      session: {
        get: async () => ({ id: 'ses_1', location: { directory: '/project' }, model: { providerID: 'proof', id: 'proof' }, agent: 'build', time: {} }),
        active: async () => ({}), list: async () => ({ data: [], cursor: {} }),
        form: { list: async () => [] }, inbox: { list: async () => [], cancel: async () => {} }, interrupt: async () => {},
        prompt: async () => { throw new Error('unknown admission'); },
      },
      permission: { request: { list: async () => ({ data: [] }) } },
      message: { list: async () => ({ data: [{ id: 'msg_failed', type: 'assistant', error: limit }, { id: 'msg_human', type: 'user' }], cursor: {} }) },
    };
    const owner = await createResponseRecoveryOwner({ dataDir: await mkdtemp(path.join(tmpdir(), 'recovery-fence-')), namespace: 'managed', client: () => api,
      archiveStore: () => ({ load: async () => ({ ok: true, authoritative: true }), getAll: async () => ({}) }) });
    try {
      await owner.processEvent(failure);
      expect(owner.isReserved('ses_1')).toBe(true);
      let routed = false; let status;
      const response = { status: value => { status = value; return response; }, json: () => {} };
      await owner.beforeRequest({ method: 'POST', originalUrl: '/api/session/ses_1/prompt' }, response, () => { routed = true; });
      expect(status).toBe(409); expect(routed).toBe(false);
      await expect(owner.suspend()).rejects.toThrow('response-recovery-admission-uncertain');
      await expect(owner.resume()).rejects.toThrow('response-recovery-admission-uncertain');
    } finally { await owner.stop(); }
  });
  it('holds recovery admission closed across the entire upstream transition', async () => {
    let reads = 0;
    const api = { session: { get: () => { reads++; return new Promise(() => {}); } } };
    const owner = await createResponseRecoveryOwner({ dataDir: await mkdtemp(path.join(tmpdir(), 'recovery-suspend-')), namespace: 'managed', client: () => api,
      archiveStore: () => ({ load: async () => ({ ok: true, authoritative: true }), getAll: async () => ({}) }) });
    try {
      await owner.suspend();
      await owner.processEvent(failure);
      expect(reads).toBe(0);
      await owner.resume();
      const work = owner.processEvent(failure);
      expect(reads).toBe(1);
      await owner.suspend(); await work;
      await owner.processEvent({ ...failure, data: { ...failure.data, sessionID: 'ses_2' }, durable: { aggregateID: 'ses_2', seq: 10 } });
      expect(reads).toBe(1);
    } finally { await owner.stop(); }
  });
  it('invalidates before a pending read completes', async () => {
    let prompts = 0;
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const api = {
      session: { get: () => held, prompt: async () => { prompts++; } },
    };
    const owner = await createResponseRecoveryOwner({ dataDir: await mkdtemp(path.join(tmpdir(), 'recovery-owner-')), namespace: 'managed', client: () => api,
      archiveStore: () => ({ load: async () => ({ ok: false }), isArchived: () => false }) });
    const work = owner.processEvent(failure);
    const drained = owner.invalidate();
    release({ id: 'ses_1', location: { directory: '/project' }, model: { providerID: 'proof', id: 'proof' }, agent: 'build', time: {} });
    await drained; await work;
    expect(prompts).toBe(0);
    await owner.stop();
  });
});

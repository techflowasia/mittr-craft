import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createPermissionAutoAcceptRuntime } from '../../../../web/server/lib/permission-auto-accept/runtime.js';
import { translateWireEvent } from '../../../../web/server/lib/event-stream/translate-v2.js';
import { createMittrSettings } from '../mittr-settings.js';
import { listen, tempDataDir, until } from '../test-helpers.js';
import {
  CHROME_PERMISSION,
  chromeQuestion,
  createChromeApprovals,
  createChromeSiteApprovals,
  createEnginePermissions,
  isChromePermission,
  mintPermissionId,
  subscribeApprovals,
} from './chrome-approvals.js';

const HOST = 'acme.example.test';

const fakeHub = () => {
  const listeners = new Set();
  let sequence = 0;
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeStatus: () => () => {},
    emitRaw: (type, data, directory = '/work/acme') => {
      sequence += 1;
      const payload = { id: `evt_${sequence}`, type, data };
      let translated;
      const event = { payload, directory, translated: () => (translated ??= translateWireEvent(payload)) };
      for (const listener of [...listeners]) listener(event);
    },
  };
};

const fakeEngine = (hub, { projects = { ses_1: 'prj_1', ses_2: 'prj_1', ses_3: 'prj_2' }, savedAllows = false } = {}) => {
  const state = { pending: new Map(), saved: [], creates: [], replies: [], removed: [], next: 0, beforeAnswer: null, effect: null };
  const projectOf = (sessionId) => projects[sessionId] ?? 'prj_other';
  const engine = {
    state,
    create: async (sessionId, request) => {
      state.creates.push({ sessionId, request });
      if (state.effect) return { effect: state.effect };
      const resource = request.resources[0];
      if (savedAllows && state.saved.some((rule) => rule.action === request.action && rule.resource === resource && rule.projectID === projectOf(sessionId))) {
        return { effect: 'allow' };
      }
      state.next += 1;
      const id = state.ignoreIds ? `per_engine_${state.next}` : request.id ?? `per_${state.next}`;
      state.pending.set(id, { id, sessionID: sessionId, ...request });
      const { message: _message, ...shown } = request;
      hub.emitRaw('permission.asked', { id, sessionID: sessionId, ...shown });
      if (state.beforeAnswer) await state.beforeAnswer(id);
      return { id, effect: 'ask' };
    },
    reply: async (sessionId, requestId, decision) => {
      const request = state.pending.get(requestId);
      if (!request || request.sessionID !== sessionId) {
        const error = new Error('The engine answered HTTP 404');
        error.status = 404;
        throw error;
      }
      state.pending.delete(requestId);
      state.replies.push({ sessionId, requestId, decision, status: 204 });
      if (decision === 'always') {
        state.saved.push({ id: `rul_${state.saved.length + 1}`, projectID: projectOf(sessionId), action: request.action, resource: request.resources[0] });
      }
      hub.emitRaw('permission.replied', { sessionID: sessionId, requestID: requestId, reply: decision });
      return null;
    },
    pending: async (sessionId) => [...state.pending.values()].filter((request) => request.sessionID === sessionId),
    saved: async () => [...state.saved],
    removeSaved: async (id) => {
      state.removed.push(id);
      state.saved = state.saved.filter((rule) => rule.id !== id);
      return null;
    },
    answer: (requestId, decision) => {
      const request = state.pending.get(requestId);
      return engine.reply(request.sessionID, requestId, decision);
    },
    pendingIds: () => [...state.pending.keys()],
  };
  return engine;
};

const quietLogger = () => {
  const lines = [];
  const record = (...args) => lines.push(args.join(' '));
  return { lines, log: record, warn: record, error: record };
};

const setUp = (t, { engineOptions, decisionWaitMs = 50, pollMs = 10 } = {}) => {
  const hub = fakeHub();
  const engine = fakeEngine(hub, engineOptions);
  const settings = createMittrSettings({ dataDir: tempDataDir(t) });
  const logger = quietLogger();
  let minted = 0;
  const mintId = () => {
    minted += 1;
    return `per_m${minted}`;
  };
  const approvals = createChromeSiteApprovals({ settings, engine, defaultDirectory: () => '/work/acme', decisionWaitMs, pollMs, denyRetryMs: 5, mintId, logger });
  const unsubscribe = subscribeApprovals(hub, approvals);
  t.after(unsubscribe);
  return { hub, engine, settings, approvals, logger };
};

const askFor = (approvals, sessionId, extra = {}) => approvals.ask({ sessionId, host: HOST, directory: '/work/acme', ...extra });

const nextRequest = async (engine, count = 1) => {
  await until(() => engine.state.pending.size >= count);
  return engine.pendingIds().at(-1);
};

test('the Chrome permission is the Chrome tool name, and only it is never answered automatically', () => {
  assert.equal(CHROME_PERMISSION, 'mittrcraft_chrome');
  assert.equal(isChromePermission({ action: 'mittrcraft_chrome', resources: [HOST] }), true);
  assert.equal(isChromePermission({ action: 'bash', resources: ['ls'] }), false);
  assert.equal(isChromePermission(undefined), false);
});

test('the server raises the engine\'s own question with the host in resources, save and metadata', async (t) => {
  const { engine, approvals } = setUp(t);
  const source = { type: 'tool', messageID: 'msg_1', id: 'call_1' };
  const asked = askFor(approvals, 'ses_1', { source });
  await engine.answer(await nextRequest(engine), 'once');
  assert.equal(await asked, 'once');
  assert.deepEqual(engine.state.creates, [{
    sessionId: 'ses_1',
    request: { id: 'per_m1', action: 'mittrcraft_chrome', resources: [HOST], save: [HOST], message: chromeQuestion(HOST), metadata: { host: HOST }, source },
  }]);
  assert.equal(chromeQuestion(HOST), `Allow the agent to use your Chrome sign-in on ${HOST}?`);
});

test('Allow once grants the session only', async (t) => {
  const { engine, approvals, settings } = setUp(t);
  const first = askFor(approvals, 'ses_1');
  await engine.answer(await nextRequest(engine), 'once');
  assert.equal(await first, 'once');
  assert.equal(await approvals.isApproved('ses_1', HOST), true);
  assert.equal(await approvals.isApproved('ses_2', HOST), false);
  assert.deepEqual((await settings.read()).tools.chromeApprovedHosts, []);

  const second = askFor(approvals, 'ses_2');
  await engine.answer(await nextRequest(engine), 'reject');
  assert.equal(await second, 'reject');
  assert.equal(engine.state.creates.length, 2);
});

test('Always saves the host and a removed host asks again', async (t) => {
  const { engine, approvals, settings } = setUp(t);
  const first = askFor(approvals, 'ses_1');
  await engine.answer(await nextRequest(engine), 'always');
  assert.equal(await first, 'always');
  await until(async () => (await settings.read()).tools.chromeApprovedHosts.includes(HOST));
  assert.equal(await approvals.isApproved('ses_3', HOST), true);
  assert.equal(engine.state.saved.length, 1);

  assert.deepEqual(await approvals.removeHost(HOST), []);
  assert.deepEqual(engine.state.removed, ['rul_1']);
  assert.equal(await approvals.isApproved('ses_1', HOST), false);
  assert.equal(await approvals.isApproved('ses_3', HOST), false);

  const again = askFor(approvals, 'ses_1');
  await engine.answer(await nextRequest(engine), 'reject');
  assert.equal(await again, 'reject');
  assert.equal(engine.state.creates.length, 2);
});

test('removing a site keeps the removal when the engine cannot be reached', async (t) => {
  const { engine, approvals, settings, logger } = setUp(t);
  await settings.update({ tools: { chromeApprovedHosts: [HOST, 'other.example.test'] } });
  engine.saved = async () => {
    throw Object.assign(new Error('The engine answered HTTP 503'), { status: 503 });
  };
  assert.deepEqual(await approvals.removeHost(HOST), ['other.example.test']);
  assert.match(logger.lines.join('\n'), /the next question about it removes it: 503/);
});

test('Don\'t allow answers the refusal and grants nothing', async (t) => {
  const { engine, approvals, settings } = setUp(t);
  const asked = askFor(approvals, 'ses_1');
  await engine.answer(await nextRequest(engine), 'reject');
  assert.equal(await asked, 'reject');
  assert.equal(await approvals.isApproved('ses_1', HOST), false);
  assert.deepEqual((await settings.read()).tools.chromeApprovedHosts, []);
});

test('an aborted turn stops waiting, and the server withdraws the question with a reject the engine accepts', async (t) => {
  const { engine, approvals, hub } = setUp(t);
  const raw = [];
  hub.subscribe((event) => raw.push(event.payload));
  const controller = new AbortController();
  const asked = askFor(approvals, 'ses_1', { signal: controller.signal });
  const requestId = await nextRequest(engine);
  controller.abort();
  await assert.rejects(asked, (error) => error.message === 'Cancelled while waiting for the user' && error.statusCode === 499);
  assert.deepEqual(engine.state.replies, [{ sessionId: 'ses_1', requestId, decision: 'reject', status: 204 }]);
  assert.deepEqual(raw.filter((payload) => payload.type === 'permission.replied').map((payload) => payload.data), [{ sessionID: 'ses_1', requestID: requestId, reply: 'reject' }]);
  assert.deepEqual(engine.pendingIds(), []);
  assert.equal(await approvals.isApproved('ses_1', HOST), false);
});

test('a call whose turn is already aborted raises no question', async (t) => {
  const { engine, approvals } = setUp(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(askFor(approvals, 'ses_1', { signal: controller.signal }), (error) => error.statusCode === 499);
  assert.deepEqual(engine.state.creates, []);
});

test('a reply event records once and always from the raw event, which the translated one lacks', async (t) => {
  const { engine, approvals, hub } = setUp(t);
  const seen = [];
  hub.subscribe((event) => {
    if (event.payload.type === 'permission.replied') seen.push({ raw: event.payload.data, translated: event.translated()[0]?.properties });
  });
  const once = askFor(approvals, 'ses_1');
  await engine.answer(await nextRequest(engine), 'once');
  assert.equal(await once, 'once');
  const always = askFor(approvals, 'ses_3');
  await engine.answer(await nextRequest(engine), 'always');
  assert.equal(await always, 'always');
  assert.deepEqual(seen.map(({ raw }) => raw.reply), ['once', 'always']);
  for (const { translated } of seen) {
    assert.equal(Object.hasOwn(translated, 'reply'), false);
    assert.equal(translated.requestID.startsWith('per_'), true);
  }
});

test('an answer that arrives before the engine\'s create answer still decides', async (t) => {
  const { engine, approvals } = setUp(t);
  engine.state.beforeAnswer = (id) => engine.answer(id, 'once');
  assert.equal(await askFor(approvals, 'ses_1'), 'once');
  assert.equal(await approvals.isApproved('ses_1', HOST), true);
});

test('an answer that arrives after the engine\'s create answer decides', async (t) => {
  const { engine, approvals } = setUp(t);
  const asked = askFor(approvals, 'ses_1');
  const requestId = await nextRequest(engine);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await engine.answer(requestId, 'always');
  assert.equal(await asked, 'always');
});

test('an answer whose event never arrives is reported after the wait, not taken as allowed', async (t) => {
  const { engine, approvals } = setUp(t, { decisionWaitMs: 30, pollMs: 5 });
  const asked = askFor(approvals, 'ses_1');
  const requestId = await nextRequest(engine);
  engine.state.pending.delete(requestId);
  await assert.rejects(asked, (error) => error.statusCode === 403 && error.message === `The user's answer for ${HOST} did not arrive; ask again`);
  assert.equal(await approvals.isApproved('ses_1', HOST), false);
});

test('a reply for another session or an unknown request records nothing', async (t) => {
  const { engine, approvals, hub } = setUp(t);
  const controller = new AbortController();
  const asked = askFor(approvals, 'ses_1', { signal: controller.signal });
  const requestId = await nextRequest(engine);
  hub.emitRaw('permission.replied', { sessionID: 'ses_2', requestID: requestId, reply: 'always' });
  hub.emitRaw('permission.replied', { sessionID: 'ses_1', requestID: 'per_unknown', reply: 'always' });
  hub.emitRaw('permission.asked', { id: 'per_crafted', sessionID: 'ses_1', action: CHROME_PERMISSION, resources: [HOST, 'evil.example.test'] });
  hub.emitRaw('permission.replied', { sessionID: 'ses_1', requestID: 'per_crafted', reply: 'always' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await approvals.isApproved('ses_1', HOST), false);
  controller.abort();
  await assert.rejects(asked, /Cancelled while waiting for the user/);
});

test('two calls for the same site in one session share one question', async (t) => {
  const { engine, approvals } = setUp(t);
  const first = askFor(approvals, 'ses_1');
  const second = askFor(approvals, 'ses_1');
  await engine.answer(await nextRequest(engine), 'once');
  assert.deepEqual(await Promise.all([first, second]), ['once', 'once']);
  assert.equal(engine.state.creates.length, 1);
});

test('the engine\'s own answer is never taken as an approval: a stale saved rule is removed and the person is asked', async (t) => {
  const { engine, approvals } = setUp(t, { engineOptions: { savedAllows: true } });
  engine.state.saved.push({ id: 'rul_stale', projectID: 'prj_1', action: CHROME_PERMISSION, resource: HOST });
  const asked = askFor(approvals, 'ses_1');
  await engine.answer(await nextRequest(engine), 'reject');
  assert.equal(await asked, 'reject');
  assert.deepEqual(engine.state.removed, ['rul_stale']);
  assert.equal(engine.state.creates.length, 2);
});

test('an engine that allows without a saved rule leaves the site refused', async (t) => {
  const { engine, approvals } = setUp(t);
  engine.state.effect = 'allow';
  await assert.rejects(askFor(approvals, 'ses_1'), (error) => error.statusCode === 503 && error.message === `MittrCraft could not ask the user about ${HOST}; try again in a moment`);
  assert.equal(await approvals.isApproved('ses_1', HOST), false);
  engine.state.effect = 'deny';
  const before = engine.state.creates.length;
  await assert.rejects(askFor(approvals, 'ses_1'), (error) => error.statusCode === 403 && error.message === `The engine refused to ask the user about ${HOST}; a permission rule may block it`);
  assert.equal(engine.state.creates.length - before, 2, 'a deny is asked once more before it is reported');
});

test('an engine that cannot raise the question leaves the site refused', async (t) => {
  const { engine, approvals } = setUp(t);
  engine.create = async () => {
    throw Object.assign(new Error('The engine answered HTTP 404'), { status: 404 });
  };
  await assert.rejects(askFor(approvals, 'ses_1'), (error) => error.statusCode === 503);
});

test('after Always the site is never asked about again, in any session or project of this Mac', async (t) => {
  const { engine, approvals } = setUp(t);
  const first = askFor(approvals, 'ses_1');
  await engine.answer(await nextRequest(engine), 'always');
  await first;
  for (const sessionId of ['ses_2', 'ses_3', 'ses_9']) assert.equal(await approvals.isApproved(sessionId, HOST), true);
  assert.equal(engine.state.creates.length, 1);
});

test('a site on MittrCraft\'s approved list is allowed without a question', async (t) => {
  const { engine, approvals, settings } = setUp(t);
  await settings.update({ tools: { chromeApprovedHosts: [HOST] } });
  assert.equal(await approvals.isApproved('ses_1', HOST), true);
  assert.equal(engine.state.creates.length, 0);
});

test('an approval in one project does not approve another: once is per session, and a rule the engine saved elsewhere counts for nothing', async (t) => {
  const { engine, approvals } = setUp(t, { engineOptions: { savedAllows: true } });
  const once = askFor(approvals, 'ses_1');
  await engine.answer(await nextRequest(engine), 'once');
  await once;
  assert.equal(await approvals.isApproved('ses_3', HOST), false);

  engine.state.saved.push({ id: 'rul_other', projectID: 'prj_1', action: CHROME_PERMISSION, resource: HOST });
  const elsewhere = askFor(approvals, 'ses_3');
  await engine.answer(await nextRequest(engine), 'reject');
  assert.equal(await elsewhere, 'reject');
  assert.equal(await approvals.isApproved('ses_3', HOST), false);
});

test('an account switch clears every session grant and withdraws the questions still open', async (t) => {
  const { engine, approvals } = setUp(t);
  const granted = askFor(approvals, 'ses_1');
  await engine.answer(await nextRequest(engine), 'once');
  await granted;
  const open = approvals.ask({ sessionId: 'ses_2', host: 'other.example.test', directory: '/work/acme' });
  const requestId = await nextRequest(engine);
  approvals.forgetAll();
  await assert.rejects(open, /Cancelled while waiting for the user/);
  assert.equal(await approvals.isApproved('ses_1', HOST), false);
  assert.deepEqual(engine.state.replies.at(-1), { sessionId: 'ses_2', requestId, decision: 'reject', status: 204 });
});

test('awaitDecision rejects on abort and settles on a recorded reply', async (t) => {
  const approvals = createChromeApprovals({ settings: createMittrSettings({ dataDir: tempDataDir(t) }) });
  const controller = new AbortController();
  const waiting = approvals.awaitDecision('ses_1', HOST, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { message: 'Cancelled while waiting for the user' });
  await assert.rejects(approvals.awaitDecision('ses_1', HOST, controller.signal), { message: 'Cancelled while waiting for the user' });
  const decided = approvals.awaitDecision('ses_1', HOST);
  await approvals.record('ses_1', HOST, 'once');
  assert.equal(await decided, 'once');
  await assert.rejects(approvals.record('ses_1', HOST, 'yes'), TypeError);
});

test('Always on an IPv6 page saves its host in the form the page address gives', async (t) => {
  const settings = createMittrSettings({ dataDir: tempDataDir(t) });
  const logger = quietLogger();
  const approvals = createChromeApprovals({ settings, logger });
  const host = new URL('http://[2001:DB8:0::1]:8080/').hostname.toLowerCase();
  assert.equal(host, '[2001:db8::1]');

  await approvals.record('ses_1', host, 'always');

  assert.deepEqual((await settings.read()).tools.chromeApprovedHosts, [host]);
  assert.equal(await approvals.isApproved('ses_2', host), true);
  assert.deepEqual(logger.lines, []);
  assert.deepEqual(await approvals.removeHost(host), []);
});

test('removeHost removes the site from settings and from every session grant', async (t) => {
  const settings = createMittrSettings({ dataDir: tempDataDir(t) });
  const approvals = createChromeApprovals({ settings });
  await approvals.record('ses_1', HOST, 'once');
  await approvals.record('ses_2', HOST, 'always');
  await approvals.record('ses_2', 'other.example.test', 'always');
  assert.deepEqual((await settings.read()).tools.chromeApprovedHosts, [HOST, 'other.example.test']);
  assert.deepEqual(await approvals.removeHost(HOST), ['other.example.test']);
  assert.equal(await approvals.isApproved('ses_1', HOST), false);
  assert.equal(await approvals.isApproved('ses_2', HOST), false);
  assert.equal(await approvals.isApproved('ses_2', 'other.example.test'), true);
  approvals.forgetSession('ses_2');
  assert.equal(await approvals.isApproved('ses_2', 'other.example.test'), true);
});

const autoAcceptAgainst = (hub, engine, { mode, evaluatePermission }) => {
  const replies = [];
  const broadcasts = [];
  const runtime = createPermissionAutoAcceptRuntime({
    globalEventHub: hub,
    buildOpenCodeUrl: (route) => `http://engine.example.test${route}`,
    getOpenCodeAuthHeaders: () => ({}),
    readSettingsFromDiskMigrated: async () => ({ permissionAutoAccept: { sessions: { ses_1: mode } } }),
    persistSettings: async () => {},
    broadcastGlobalUiEvent: (event) => broadcasts.push(event),
    evaluatePermission,
    neverAutoAnswer: isChromePermission,
    retryDelaysMs: [0],
    fetchImpl: async (url, init) => {
      const match = /\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(new URL(url).pathname);
      if (match && init?.method === 'POST') {
        replies.push(match[2]);
        await engine.reply(decodeURIComponent(match[1]), decodeURIComponent(match[2]), JSON.parse(init.body).decision);
        return new Response(null, { status: 204 });
      }
      return Response.json({ data: [] });
    },
  });
  return { runtime, replies, broadcasts, stop: runtime.start() };
};

for (const mode of ['auto', 'safety']) {
  test(`${mode === 'auto' ? 'an auto' : 'a safety'} session leaves the Chrome question for the person and broadcasts it`, async (t) => {
    const { hub, engine, approvals } = setUp(t);
    const classifier = [];
    const auto = autoAcceptAgainst(hub, engine, { mode, evaluatePermission: async (permission) => { classifier.push(permission.id); return { action: 'accept' }; } });
    t.after(auto.stop);
    await auto.runtime.load();
    const controller = new AbortController();
    const asked = askFor(approvals, 'ses_1', { signal: controller.signal });
    const requestId = await nextRequest(engine);
    await until(() => auto.broadcasts.some((event) => event.type === 'openchamber:permission-auto-accept.left-for-user'));
    assert.deepEqual(auto.broadcasts.filter((event) => event.type === 'openchamber:permission-auto-accept.left-for-user').map((event) => event.properties.permissionId), [requestId]);
    assert.equal(await auto.runtime.isPermissionAutoAnswered('ses_1', '/work/acme', requestId), false);
    assert.deepEqual(auto.replies, []);
    assert.deepEqual(classifier, []);
    await engine.answer(requestId, 'once');
    assert.equal(await asked, 'once');
  });
}

test('the reply count for an auto session is zero, while another request in it is answered', async (t) => {
  const { hub, engine, approvals } = setUp(t);
  const auto = autoAcceptAgainst(hub, engine, { mode: 'auto' });
  t.after(auto.stop);
  await auto.runtime.load();
  const controller = new AbortController();
  const asked = askFor(approvals, 'ses_1', { signal: controller.signal });
  const chromeRequest = await nextRequest(engine);
  engine.state.pending.set('per_bash', { id: 'per_bash', sessionID: 'ses_1', action: 'bash', resources: ['ls'] });
  hub.emitRaw('permission.asked', { id: 'per_bash', sessionID: 'ses_1', action: 'bash', resources: ['ls'] });
  await until(() => auto.replies.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(auto.replies, ['per_bash']);
  assert.equal(engine.state.pending.has(chromeRequest), true);
  controller.abort();
  await assert.rejects(asked, /Cancelled while waiting for the user/);
});

test('the engine client raises, answers, lists and removes through the engine\'s permission routes', async (t) => {
  const seen = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    seen.push({ method: req.method, path: req.path, directory: req.get('x-opencode-directory') ?? null, auth: req.get('authorization') ?? null, body: req.body });
    next();
  });
  app.post('/api/session/:id/permission', (_req, res) => res.json({ data: { id: 'per_1', effect: 'ask' } }));
  app.post('/api/session/:id/permission/:pid/reply', (req, res) => res.status(req.params.pid === 'per_gone' ? 404 : 204).end());
  app.get('/api/session/:id/permission', (_req, res) => res.json({ data: [{ id: 'per_1' }] }));
  app.get('/api/permission/saved', (_req, res) => res.json({ data: [{ id: 'rul_1', action: CHROME_PERMISSION, resource: HOST }] }));
  app.delete('/api/permission/saved/:id', (_req, res) => res.status(204).end());
  const base = await listen(t, app);
  const engine = createEnginePermissions({ opencode: { url: (route) => `${base}${route}`, authHeaders: () => ({ authorization: 'Basic acme' }) } });

  assert.deepEqual(await engine.create('ses 1', { action: CHROME_PERMISSION, resources: [HOST] }), { id: 'per_1', effect: 'ask' });
  assert.equal(await engine.reply('ses 1', 'per_1', 'reject'), null);
  assert.deepEqual(await engine.pending('ses 1'), [{ id: 'per_1' }]);
  assert.deepEqual(await engine.saved('/work/a b'), [{ id: 'rul_1', action: CHROME_PERMISSION, resource: HOST }]);
  assert.equal(await engine.removeSaved('rul_1', '/work/a b'), null);
  assert.deepEqual(seen.map(({ method, path, directory }) => [method, path, directory]), [
    ['POST', '/api/session/ses%201/permission', null],
    ['POST', '/api/session/ses%201/permission/per_1/reply', null],
    ['GET', '/api/session/ses%201/permission', null],
    ['GET', '/api/permission/saved', encodeURIComponent('/work/a b')],
    ['DELETE', '/api/permission/saved/rul_1', encodeURIComponent('/work/a b')],
  ]);
  assert.deepEqual(seen[1].body, { decision: 'reject' });
  assert.ok(seen.every(({ auth }) => auth === 'Basic acme'));
  await assert.rejects(engine.reply('ses 1', 'per_gone', 'reject'), (error) => error.status === 404);
});

test('a minted id is a permission id the engine accepts, and never repeats', () => {
  const ids = new Set(Array.from({ length: 200 }, () => mintPermissionId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^per_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
});

test('only the request the server raised decides: an outside request for the same session and site answered once approves nothing', async (t) => {
  const { engine, approvals, hub } = setUp(t);
  const controller = new AbortController();
  const asked = askFor(approvals, 'ses_1', { signal: controller.signal });
  const own = await nextRequest(engine);
  engine.state.pending.set('per_outside', { id: 'per_outside', sessionID: 'ses_1', action: CHROME_PERMISSION, resources: [HOST], save: [HOST], metadata: { host: HOST } });
  hub.emitRaw('permission.asked', { id: 'per_outside', sessionID: 'ses_1', action: CHROME_PERMISSION, resources: [HOST], save: [HOST], metadata: { host: HOST } });
  await engine.answer('per_outside', 'once');
  let settled = false;
  asked.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settled, false, 'the call still waits for its own question');
  assert.equal(await approvals.isApproved('ses_1', HOST), false);
  assert.deepEqual(engine.pendingIds(), [own]);
  controller.abort();
  await assert.rejects(asked, /Cancelled while waiting for the user/);
});

test('an engine that raises the question under another id has it withdrawn and the site stays refused', async (t) => {
  const { engine, approvals } = setUp(t);
  engine.state.ignoreIds = true;
  await assert.rejects(askFor(approvals, 'ses_1'), (error) => error.statusCode === 503);
  assert.deepEqual(engine.state.replies.map(({ requestId, decision }) => [requestId, decision]), [['per_engine_1', 'reject']]);
  assert.equal(await approvals.isApproved('ses_1', HOST), false);
});

test('a deny from a location that is still starting is asked once more before it is reported', async (t) => {
  const { engine, approvals } = setUp(t);
  const effects = ['deny'];
  const create = engine.create;
  engine.create = (sessionId, request) => {
    const effect = effects.shift();
    if (effect) {
      engine.state.creates.push({ sessionId, request });
      return Promise.resolve({ effect });
    }
    return create(sessionId, request);
  };
  const asked = askFor(approvals, 'ses_1');
  await engine.answer(await nextRequest(engine), 'once');
  assert.equal(await asked, 'once');
  assert.deepEqual(engine.state.creates.map(({ request }) => request.id), ['per_m1', 'per_m2']);
});

test('Always for a site settles every other session\'s open question about it', async (t) => {
  const { engine, approvals } = setUp(t);
  const first = askFor(approvals, 'ses_1');
  const firstId = await nextRequest(engine, 1);
  const second = askFor(approvals, 'ses_3');
  const secondId = await nextRequest(engine, 2);
  const other = approvals.ask({ sessionId: 'ses_2', host: 'other.example.test', directory: '/work/acme' });
  const otherId = await nextRequest(engine, 3);
  await engine.answer(firstId, 'always');
  assert.equal(await first, 'always');
  assert.equal(await second, 'always');
  assert.equal(await approvals.isApproved('ses_3', HOST), true);
  assert.deepEqual(engine.state.replies.map(({ requestId, decision }) => [requestId, decision]), [[firstId, 'always'], [secondId, 'once']]);
  assert.deepEqual(engine.pendingIds(), [otherId]);
  await engine.answer(otherId, 'reject');
  assert.equal(await other, 'reject');
});

test('an answer that arrives before the question is known is held for the wait, then dropped', async (t) => {
  const { engine, approvals, hub } = setUp(t, { decisionWaitMs: 40 });
  engine.state.beforeAnswer = async (id) => {
    hub.emitRaw('permission.replied', { sessionID: 'ses_1', requestID: id, reply: 'once' });
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  assert.equal(await askFor(approvals, 'ses_1'), 'once');

  engine.state.beforeAnswer = null;
  hub.emitRaw('permission.replied', { sessionID: 'ses_2', requestID: 'per_m2', reply: 'always' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const controller = new AbortController();
  const late = askFor(approvals, 'ses_2', { signal: controller.signal });
  await nextRequest(engine);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await approvals.isApproved('ses_2', HOST), false, 'a reply held past the wait decides nothing');
  controller.abort();
  await assert.rejects(late, /Cancelled while waiting for the user/);
});

test('a held answer from another session decides nothing', async (t) => {
  const { engine, approvals, hub } = setUp(t);
  engine.state.beforeAnswer = (id) => hub.emitRaw('permission.replied', { sessionID: 'ses_2', requestID: id, reply: 'always' });
  const controller = new AbortController();
  const asked = askFor(approvals, 'ses_1', { signal: controller.signal });
  await nextRequest(engine);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await approvals.isApproved('ses_1', HOST), false);
  controller.abort();
  await assert.rejects(asked, /Cancelled while waiting for the user/);
});

test('each waiting call stops on its own turn\'s abort, and the shared question stays for the other', async (t) => {
  const { engine, approvals } = setUp(t);
  const firstTurn = new AbortController();
  const secondTurn = new AbortController();
  const first = askFor(approvals, 'ses_1', { signal: firstTurn.signal });
  const second = askFor(approvals, 'ses_1', { signal: secondTurn.signal });
  const requestId = await nextRequest(engine);
  firstTurn.abort();
  await assert.rejects(first, (error) => error.statusCode === 499);
  assert.deepEqual(engine.state.replies, []);
  assert.deepEqual(engine.pendingIds(), [requestId]);
  await engine.answer(requestId, 'once');
  assert.equal(await second, 'once');
  assert.equal(engine.state.creates.length, 1);
});

test('a call that joins a question whose last caller just left starts its own question', async (t) => {
  const { engine, approvals } = setUp(t);
  let releaseCreate;
  const gate = new Promise((resolve) => { releaseCreate = resolve; });
  const create = engine.create;
  let held = true;
  engine.create = async (sessionId, request) => {
    if (held) {
      held = false;
      await gate;
    }
    return create(sessionId, request);
  };
  const firstTurn = new AbortController();
  const first = askFor(approvals, 'ses_1', { signal: firstTurn.signal });
  await until(() => engine.state.creates.length === 0 && !held);
  firstTurn.abort();
  const second = askFor(approvals, 'ses_1');
  releaseCreate();
  await assert.rejects(first, (error) => error.statusCode === 499);
  await until(() => engine.state.pending.size === 1 && engine.state.creates.length === 2);
  await engine.answer(engine.pendingIds()[0], 'once');
  assert.equal(await second, 'once');
});

test('a create that raised the card but then failed closes it with a reject', async (t) => {
  const { engine, approvals } = setUp(t);
  const create = engine.create;
  engine.create = async (sessionId, request) => {
    await create(sessionId, request);
    throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
  };
  await assert.rejects(askFor(approvals, 'ses_1'), (error) => error.statusCode === 503);
  assert.deepEqual(engine.state.replies.map(({ requestId, decision }) => [requestId, decision]), [['per_m1', 'reject']]);
  assert.deepEqual(engine.pendingIds(), []);
});

test('a reply held twice for the same id keeps the newer one for the whole wait', async (t) => {
  const { engine, approvals, hub } = setUp(t, { decisionWaitMs: 60 });
  hub.emitRaw('permission.replied', { sessionID: 'ses_1', requestID: 'per_m1', reply: 'reject' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  hub.emitRaw('permission.replied', { sessionID: 'ses_1', requestID: 'per_m1', reply: 'once' });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(await askFor(approvals, 'ses_1'), 'once');
});

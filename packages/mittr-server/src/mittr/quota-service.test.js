import assert from 'node:assert/strict';
import test from 'node:test';

import { createMittrQuotaService } from './quota-service.js';
import { fakeFetch, json } from './test-helpers.js';
import { createSpeechState } from './voice/speech-state.js';

const BROKER = { baseUrl: 'https://api-dev.mittr.asia', upstreamV1: 'https://api-dev.mittr.asia/v1' };
const SESSION = { accessToken: 'at-1', subject: { userId: 'u-a' } };
const WEEK = {
  weekStart: '2026-10-12T17:00:00.000Z',
  resetsAt: '2026-10-19T17:00:00.000Z',
  lines: [
    { modelKey: 'mk-1', kind: 'chat', label: 'Writer', used: 30, limit: 50, source: 'group' },
    { modelKey: 'mk-2', kind: 'stt', label: 'Voice', used: 30, limit: 600, source: 'default' },
  ],
};

const setUp = ({ session = SESSION, fetchImpl = fakeFetch(() => json(WEEK)), broker = BROKER, timeoutMs } = {}) => ({
  fetchImpl,
  service: createMittrQuotaService({ broker, ensureFreshSession: async () => session, fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) }),
});

const failure = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the read to fail');
};

test('concurrent raw reads share only an in-flight sample', async () => {
  let release;
  const fetchImpl = fakeFetch(() => new Promise((resolve) => { release = resolve; }));
  const { service } = setUp({ fetchImpl });
  const first = service.readMine();
  const second = service.readMine();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchImpl.calls.length, 1);
  release(json(WEEK));
  assert.deepEqual(await first, await second);
  const next = service.readMine();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchImpl.calls.length, 2);
  release(json(WEEK));
  await next;
});

test('account generation fences A to B to A samples and late session refreshes', async () => {
  let generation = 0;
  let release;
  const service = createMittrQuotaService({ broker: BROKER, accountGeneration: () => generation,
    ensureFreshSession: async () => SESSION, fetchImpl: () => new Promise((resolve) => { release = resolve; }) });
  const stale = service.readMine();
  await new Promise((resolve) => setImmediate(resolve));
  generation = 2;
  release(json(WEEK));
  assert.equal((await failure(stale)).reasonCode, 'account_changed');
  let refreshed;
  const late = createMittrQuotaService({ broker: BROKER, accountGeneration: () => generation,
    ensureFreshSession: () => new Promise((resolve) => { refreshed = resolve; }),
    fetchImpl: () => { assert.fail('old request must not fetch with the new account token'); } });
  const reading = late.readMine();
  generation += 1;
  refreshed(SESSION);
  assert.equal((await failure(reading)).reasonCode, 'account_changed');
});

test('a new generation reads independently while the old account sample is pending', async () => {
  let generation = 0;
  const releases = [];
  const service = createMittrQuotaService({ broker: BROKER, accountGeneration: () => generation,
    ensureFreshSession: async () => SESSION, fetchImpl: () => new Promise((resolve) => releases.push(resolve)) });
  const first = service.readMine().catch((error) => error.reasonCode);
  await new Promise((resolve) => setImmediate(resolve));
  generation += 1;
  const second = service.readMine();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 2);
  releases[1](json(WEEK));
  assert.deepEqual(await second, WEEK);
  releases[0](json(WEEK));
  assert.equal(await first, 'account_changed');
});

test('failed and malformed reads preserve speech blocks and a newer refusal survives a positive read', async (t) => {
  const state = createSpeechState();
  t.after(() => state.close());
  state.block('stt', null);
  for (const response of [json({}, 500), json({}), json({ ...WEEK, lines: [] }), json({ ...WEEK, lines: [{ ...WEEK.lines[1], used: '0' }] })]) {
    const service = createMittrQuotaService({ broker: BROKER, ensureFreshSession: async () => SESSION, speechState: state, fetchImpl: async () => response });
    await service.readMine().catch(() => {});
    assert.ok(state.view().stt.blockedUntil);
  }
  let release;
  const service = createMittrQuotaService({ broker: BROKER, ensureFreshSession: async () => SESSION, speechState: state,
    fetchImpl: () => new Promise((resolve) => { release = resolve; }) });
  const reading = service.readMine();
  await new Promise((resolve) => setImmediate(resolve));
  state.block('stt', null);
  release(json(WEEK));
  await reading;
  assert.ok(state.view().stt.blockedUntil);
});

test('quota me reads this week from the platform with the account token', async () => {
  const { service, fetchImpl } = setUp();
  assert.deepEqual(await service.readMine(), WEEK);
  const [request] = fetchImpl.calls;
  assert.equal(request.url, 'https://api-dev.mittr.asia/api/quota/me');
  assert.equal(request.method, 'GET');
  assert.equal(request.headers.Authorization, 'Bearer at-1');
  assert.ok(request.signal, 'the platform call has a time limit');
});

test('quota me maps a 401 to not_signed_in', async () => {
  const { service } = setUp({ fetchImpl: fakeFetch(() => json({ message: 'no' }, 401)) });
  const error = await failure(service.readMine());
  assert.equal(error.reasonCode, 'not_signed_in');
  assert.equal(error.statusCode, 401);
});

test('quota me maps a 403 to not_permitted, a signed-in person the platform will not show it to', async () => {
  const { service } = setUp({ fetchImpl: fakeFetch(() => json({}, 403)) });
  const error = await failure(service.readMine());
  assert.equal(error.reasonCode, 'not_permitted');
  assert.equal(error.statusCode, 403);
});

test('quota me without a session is not_signed_in and does not call the platform', async () => {
  const { service, fetchImpl } = setUp({ session: null });
  const error = await failure(service.readMine());
  assert.equal(error.reasonCode, 'not_signed_in');
  assert.equal(error.statusCode, 401);
  assert.equal(fetchImpl.calls.length, 0);
});

test('quota me maps a 404 to not_available', async () => {
  const { service } = setUp({ fetchImpl: fakeFetch(() => json({}, 404)) });
  const error = await failure(service.readMine());
  assert.equal(error.reasonCode, 'not_available');
  assert.equal(error.statusCode, 404);
});

test('quota me maps a platform failure to upstream_failed', async () => {
  const { service } = setUp({ fetchImpl: fakeFetch(() => json({}, 500)) });
  const error = await failure(service.readMine());
  assert.equal(error.reasonCode, 'upstream_failed');
  assert.equal(error.statusCode, 502);
});

test('quota me maps a body it cannot read to upstream_failed', async () => {
  for (const body of [{ weekStart: 'x' }, { ...WEEK, resetsAt: 'soon' }, { ...WEEK, lines: 'none' }, null]) {
    const { service } = setUp({ fetchImpl: fakeFetch(() => json(body)) });
    assert.equal((await failure(service.readMine())).reasonCode, 'upstream_failed');
  }
  const { service } = setUp({ fetchImpl: fakeFetch(() => new Response('not json', { status: 200 })) });
  assert.equal((await failure(service.readMine())).reasonCode, 'upstream_failed');
});

test('quota me maps a network failure to unreachable', async () => {
  const { service } = setUp({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  const error = await failure(service.readMine());
  assert.equal(error.reasonCode, 'unreachable');
  assert.equal(error.statusCode, 502);
});

test('quota me maps a platform that never answers to upstream_timeout', async () => {
  const hang = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  });
  const { service } = setUp({ fetchImpl: hang, timeoutMs: 20 });
  const error = await failure(service.readMine());
  assert.equal(error.reasonCode, 'upstream_timeout');
  assert.equal(error.statusCode, 504);
});

test('quota me without a broker is not_configured', async () => {
  const { service, fetchImpl } = setUp({ broker: null });
  const error = await failure(service.readMine());
  assert.equal(error.reasonCode, 'not_configured');
  assert.equal(error.statusCode, 503);
  assert.equal(fetchImpl.calls.length, 0);
});

test('quota me drops a line it cannot read instead of failing the week', async () => {
  const lines = [
    ...WEEK.lines,
    { modelKey: 'x', kind: 'video', label: 'X', used: 1, limit: 2, source: 'user' },
    { modelKey: 'y', kind: 'chat', label: 'Y', used: -1, limit: 2, source: 'user' },
    { modelKey: 'z', kind: 'chat', label: 'Z', used: 1, limit: 0, source: 'user' },
    { kind: 'chat' },
  ];
  const { service } = setUp({ fetchImpl: fakeFetch(() => json({ ...WEEK, lines })) });
  assert.deepEqual((await service.readMine()).lines, WEEK.lines);
});

test('quota me keeps role names and the agents behind a model', async () => {
  const body = {
    ...WEEK,
    lines: [
      { modelKey: 'm:abc', kind: 'chat', label: '', labelKey: 'quota.role.decision', used: 10, limit: 100, source: 'default', agents: [{ key: 'assistant', label: 'General Assistant' }, { key: 'bad' }] },
      { modelKey: 'm:def', kind: 'chat', label: '', labelKey: '<script>', used: 1, limit: 100, source: 'default' },
    ],
  };
  const { service } = setUp({ fetchImpl: fakeFetch(() => json(body)) });
  assert.deepEqual((await service.readMine()).lines, [
    { modelKey: 'm:abc', kind: 'chat', label: '', labelKey: 'quota.role.decision', used: 10, limit: 100, source: 'default', agents: [{ key: 'assistant', label: 'General Assistant' }] },
    { modelKey: 'm:def', kind: 'chat', label: '', used: 1, limit: 100, source: 'default' },
  ]);
});

test('quota JSON preserves an own __proto__ alias status', async () => {
  const body = JSON.parse(JSON.stringify({ ...WEEK, agentStatus: {
    ['__proto__']: { modelKey: 'mk-1', left: 20, limit: 50, resetsAt: WEEK.resetsAt, state: 'near' },
  } }));
  const { service } = setUp({ fetchImpl: fakeFetch(() => json(body)) });
  const parsed = await service.readMine();
  assert.ok(Object.hasOwn(parsed.agentStatus ?? {}, '__proto__'));
  const serialized = JSON.parse(JSON.stringify(parsed));
  assert.deepEqual(Object.keys(serialized.agentStatus), ['__proto__']);
  assert.equal(serialized.agentStatus.__proto__.modelKey, 'mk-1');
  assert.equal(serialized.agentStatus.__proto__.left, 20);
});

test('agent status is keyed by alias', async () => {
  const body = {
    ...WEEK,
    agentStatus: {
      writer: { modelKey: 'mk-1', left: 20, limit: 50, resetsAt: WEEK.resetsAt, state: 'near', percentLeft: 40 },
      reader: { modelKey: 'mk-1', left: 0, limit: 50, resetsAt: WEEK.resetsAt, state: 'substitute', substituteLabel: 'MITTR 1.0 fast' },
      broken: { modelKey: 'mk-1', state: 'gone' },
    },
  };
  const { service } = setUp({ fetchImpl: fakeFetch(() => json(body)) });
  const { agentStatus } = await service.readMine();
  assert.deepEqual(Object.keys(agentStatus).sort(), ['reader', 'writer']);
  assert.deepEqual(agentStatus.writer, body.agentStatus.writer);
  assert.deepEqual(agentStatus.reader, body.agentStatus.reader);
});

test('quota me has no agent status when the platform sends none usable', async () => {
  const { service } = setUp({ fetchImpl: fakeFetch(() => json({ ...WEEK, agentStatus: { a: { state: 'gone' } } })) });
  assert.equal('agentStatus' in (await service.readMine()), false);
});

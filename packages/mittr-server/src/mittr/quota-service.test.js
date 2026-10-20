import assert from 'node:assert/strict';
import test from 'node:test';

import { createMittrQuotaService } from './quota-service.js';
import { fakeFetch, json } from './test-helpers.js';

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

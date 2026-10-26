import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { CANNOT_REACH_MITTR } from './platform.js';
import { fakeFetch, json, serve } from './test-helpers.js';
import { registerMittrWorkRoutes } from './work-routes.js';

const BROKER = { baseUrl: 'https://api-dev.mittr.asia', upstreamV1: 'https://api-dev.mittr.asia/v1' };
const TOKEN = 'at-secret-token-9f3a';
const sessionOf = (userId, accessToken = TOKEN) => ({ accessToken, subject: { userId } });

const ITEMS = [
  {
    id: 'p-1', title: 'Ship the picker', project: 'MITRAI', phase: 'Build', state: 'started', priority: 'high',
    due: '2026-10-30', estimate: '3', url: 'https://plane.example/MITRAI-12', updatedAt: '2026-10-20T08:00:00.000Z',
    source: 'plane', key: 'MITRAI-12', workspace: 'mittr',
  },
  {
    id: 'j-1', title: 'Fix the audit', project: 'MRKB', phase: null, state: 'To Do', priority: null,
    due: null, estimate: null, url: 'https://jira.example/browse/MRKB-2122', updatedAt: '2026-10-19T08:00:00.000Z',
    source: 'jira', key: 'MRKB-2122',
  },
];

const recordingLogger = () => {
  const lines = [];
  const record = (...args) => lines.push(args.map(String).join(' '));
  return { lines, log: record, warn: record, error: record };
};

const setUp = async (t, {
  fetchImpl = fakeFetch(() => json({ items: ITEMS })),
  ensureFreshSession = async () => sessionOf('u-a'),
  broker = BROKER,
} = {}) => {
  const app = express();
  const logger = recordingLogger();
  registerMittrWorkRoutes(app, { broker, ensureFreshSession, fetchImpl, logger });
  return { call: await serve(t, app), fetchImpl, logger };
};

test("the platform's items are passed through with the account they belong to", async (t) => {
  const { call, fetchImpl } = await setUp(t);
  const reply = await call('GET', '/api/mittr/work');
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { configured: true, items: ITEMS, userId: 'u-a' });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://api-dev.mittr.asia/desktop/work');
  assert.equal(fetchImpl.calls[0].method, 'GET');
  assert.equal(fetchImpl.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(fetchImpl.calls[0].signal instanceof AbortSignal);
});

test('the reply names the account it was read for', async (t) => {
  const { call, fetchImpl } = await setUp(t, { ensureFreshSession: async () => sessionOf('u-b', 'at-b') });
  const reply = await call('GET', '/api/mittr/work');
  assert.equal(reply.body.userId, 'u-b');
  assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer at-b');
});

test('each read names the account active when it was made', async (t) => {
  let active = 'u-a';
  const { call } = await setUp(t, { ensureFreshSession: async () => sessionOf(active) });
  assert.equal((await call('GET', '/api/mittr/work')).body.userId, 'u-a');
  active = 'u-b';
  assert.equal((await call('GET', '/api/mittr/work')).body.userId, 'u-b');
});

test('no account answers not configured and asks the platform nothing', async (t) => {
  const { call, fetchImpl } = await setUp(t, { ensureFreshSession: async () => null });
  const reply = await call('GET', '/api/mittr/work');
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { configured: false, items: [], userId: null });
  assert.equal(fetchImpl.calls.length, 0);
});

test('no broker answers not configured and asks nobody anything', async (t) => {
  let asked = 0;
  const { call, fetchImpl } = await setUp(t, { broker: null, ensureFreshSession: async () => { asked += 1; return sessionOf('u-a'); } });
  const reply = await call('GET', '/api/mittr/work');
  assert.deepEqual(reply.body, { configured: false, items: [], userId: null });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(asked, 0);
});

test('a reply without a list of items answers an empty list', async (t) => {
  const { call } = await setUp(t, { fetchImpl: fakeFetch(() => json({ items: 'nope' })) });
  assert.deepEqual((await call('GET', '/api/mittr/work')).body, { configured: true, items: [], userId: 'u-a' });
});

test('the platform hints are not passed on', async (t) => {
  const { call } = await setUp(t, { fetchImpl: fakeFetch(() => json({ items: ITEMS, hints: [{ code: 'plane_email_unmatched' }] })) });
  assert.deepEqual(Object.keys((await call('GET', '/api/mittr/work')).body).sort(), ['configured', 'items', 'userId']);
});

test("a 401 passes the platform's message", async (t) => {
  const { call } = await setUp(t, { fetchImpl: fakeFetch(() => json({ error: 'Token expired' }, 401)) });
  assert.deepEqual(await call('GET', '/api/mittr/work'), { status: 401, body: { error: 'Token expired' } });
});

test('a 403 without a message answers the fixed text, and a bare HTTP reason is not the message', async (t) => {
  const bare = await setUp(t, { fetchImpl: fakeFetch(() => json({ error: 'Forbidden' }, 403)) });
  assert.deepEqual(await bare.call('GET', '/api/mittr/work'), { status: 403, body: { error: 'Not authorized to read work items' } });
  const nest = await setUp(t, { fetchImpl: fakeFetch(() => json({ error: 'Forbidden', message: 'No Plane account matches this email' }, 403)) });
  assert.deepEqual(await nest.call('GET', '/api/mittr/work'), { status: 403, body: { error: 'No Plane account matches this email' } });
  const none = await setUp(t, { fetchImpl: fakeFetch(() => new Response('not json', { status: 401 })) });
  assert.deepEqual(await none.call('GET', '/api/mittr/work'), { status: 401, body: { error: 'Not authorized to read work items' } });
});

test('a 5xx answers 503', async (t) => {
  const { call } = await setUp(t, { fetchImpl: fakeFetch(() => json({ error: 'boom' }, 500)) });
  assert.deepEqual(await call('GET', '/api/mittr/work'), { status: 503, body: { error: 'Mittr platform is unavailable' } });
});

test('another refusal answers the fixed text with the platform status', async (t) => {
  for (const status of [404, 409]) {
    const { call } = await setUp(t, { fetchImpl: fakeFetch(() => json({ error: 'Not Found', message: 'somewhere else' }, status)) });
    assert.deepEqual(await call('GET', '/api/mittr/work'), { status, body: { error: 'Failed to load work items' } });
  }
});

test('a timeout answers 504', async (t) => {
  const { call, fetchImpl } = await setUp(t, {
    fetchImpl: fakeFetch(() => { throw new DOMException('The operation timed out', 'TimeoutError'); }),
  });
  assert.deepEqual(await call('GET', '/api/mittr/work'), { status: 504, body: { error: 'Mittr platform request timed out' } });
  assert.equal(fetchImpl.calls.length, 1);
});

test('a network failure answers 502 Cannot reach Mittr', async (t) => {
  const { call } = await setUp(t, { fetchImpl: fakeFetch(() => { throw new TypeError('fetch failed'); }) });
  assert.deepEqual(await call('GET', '/api/mittr/work'), { status: 502, body: { error: CANNOT_REACH_MITTR } });
});

test('a session that cannot be refreshed answers a plain failure, not a hang', async (t) => {
  const { call } = await setUp(t, { ensureFreshSession: async () => { throw new Error('keychain locked'); } });
  assert.deepEqual(await call('GET', '/api/mittr/work'), { status: 500, body: { error: 'Failed to load work items' } });
});

test('the access token appears in no reply or log line', async (t) => {
  const cases = [
    fakeFetch(() => json({ items: ITEMS })),
    fakeFetch(() => json({ error: 'Token expired' }, 401)),
    fakeFetch(() => json({ error: 'Forbidden' }, 403)),
    fakeFetch(() => json({}, 500)),
    fakeFetch(() => json({}, 404)),
    fakeFetch(() => { throw new DOMException('timed out', 'TimeoutError'); }),
    fakeFetch(() => { throw new TypeError(`fetch failed for Bearer ${TOKEN}`); }),
  ];
  for (const fetchImpl of cases) {
    const { call, logger } = await setUp(t, { fetchImpl });
    const reply = await call('GET', '/api/mittr/work');
    assert.equal(JSON.stringify(reply).includes(TOKEN), false);
    assert.equal(logger.lines.some((line) => line.includes(TOKEN)), false);
  }
  const none = await setUp(t, { ensureFreshSession: async () => null });
  assert.equal(JSON.stringify(await none.call('GET', '/api/mittr/work')).includes(TOKEN), false);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { registerMittrIntegrationsRoutes } from './integrations-routes.js';
import { CANNOT_REACH_MITTR, PLATFORM_TIMED_OUT } from './platform.js';
import { fakeFetch, json, serve } from './test-helpers.js';

const BROKER = { baseUrl: 'https://api-dev.mittr.asia', upstreamV1: 'https://api-dev.mittr.asia/v1' };
const ACCESS = 'at-secret-token-9f3a';
const JIRA_SECRET = 'jira-secret-123';
const PLANE_SECRET = 'plane-secret-456';
const sessionOf = (userId, accessToken = ACCESS) => ({ accessToken, subject: { userId } });

const CONFIG = {
  jira: { baseUrl: 'https://x.atlassian.net', email: 'a@x', hasToken: true, configured: true },
  plane: { baseUrl: 'https://plane.example', workspaceSlug: 'mittr', workspaceSlugs: ['mittr', 'craft'], hasApiKey: true, configured: true },
};

const recordingLogger = () => {
  const lines = [];
  const record = (...args) => lines.push(args.map(String).join(' '));
  return { lines, log: record, warn: record, error: record };
};

const setUp = async (t, {
  fetchImpl = fakeFetch(() => json(CONFIG)),
  ensureFreshSession = async () => sessionOf('u-a'),
  broker = BROKER,
} = {}) => {
  const app = express();
  const logger = recordingLogger();
  registerMittrIntegrationsRoutes(app, { express, broker, ensureFreshSession, fetchImpl, logger });
  return { call: await serve(t, app), fetchImpl, logger };
};

test("GET answers the platform's config with the account it is for", async (t) => {
  const { call, fetchImpl } = await setUp(t);
  const reply = await call('GET', '/api/mittr/integrations');
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { ...CONFIG, userId: 'u-a' });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://api-dev.mittr.asia/api/integrations');
  assert.equal(fetchImpl.calls[0].method, 'GET');
  assert.equal(fetchImpl.calls[0].headers.authorization, `Bearer ${ACCESS}`);
  assert.ok(fetchImpl.calls[0].signal instanceof AbortSignal);
});

test('GET keeps only the Jira and Plane blocks of what the platform sends', async (t) => {
  const everything = {
    ...CONFIG,
    email: { configured: true },
    slack: { configured: true },
    http: { configured: false },
    github: { configured: true },
    websearch: { configured: false },
  };
  const { call } = await setUp(t, { fetchImpl: fakeFetch(() => json(everything)) });
  const reply = await call('GET', '/api/mittr/integrations');
  assert.deepEqual(Object.keys(reply.body).sort(), ['jira', 'plane', 'userId']);
});

test('each reply names the account whose session made the request', async (t) => {
  let active = 'u-a';
  const { call, fetchImpl } = await setUp(t, { ensureFreshSession: async () => sessionOf(active, `at-${active}`) });
  assert.equal((await call('GET', '/api/mittr/integrations')).body.userId, 'u-a');
  active = 'u-b';
  assert.equal((await call('GET', '/api/mittr/integrations')).body.userId, 'u-b');
  assert.equal(fetchImpl.calls[1].headers.authorization, 'Bearer at-u-b');
});

test('PUT forwards only jira and plane', async (t) => {
  const { call, fetchImpl } = await setUp(t);
  const jira = { baseUrl: 'https://x.atlassian.net', email: 'a@x', token: JIRA_SECRET };
  const reply = await call('PUT', '/api/mittr/integrations', { expectUserId: 'u-a', jira, extra: { nope: true }, userId: 'u-z' });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { ...CONFIG, userId: 'u-a' });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://api-dev.mittr.asia/api/integrations');
  assert.equal(fetchImpl.calls[0].method, 'PUT');
  assert.equal(fetchImpl.calls[0].headers.authorization, `Bearer ${ACCESS}`);
  assert.equal(fetchImpl.calls[0].headers['content-type'], 'application/json');
  assert.deepEqual(fetchImpl.calls[0].body, { jira });
});

test('PUT forwards jira and plane together', async (t) => {
  const { call, fetchImpl } = await setUp(t);
  const body = {
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@x', token: JIRA_SECRET },
    plane: { baseUrl: 'https://plane.example', workspaceSlugs: ['mittr', 'craft'], apiKey: PLANE_SECRET },
  };
  await call('PUT', '/api/mittr/integrations', { expectUserId: 'u-a', ...body });
  assert.deepEqual(fetchImpl.calls[0].body, body);
});

test('a save for an account that is no longer active is refused and nothing is sent', async (t) => {
  const { call, fetchImpl } = await setUp(t, { ensureFreshSession: async () => sessionOf('u-b') });
  const reply = await call('PUT', '/api/mittr/integrations', { expectUserId: 'u-a', jira: { baseUrl: 'https://x.atlassian.net', email: 'a@x', token: JIRA_SECRET } });
  assert.deepEqual(reply, { status: 409, body: { error: 'The Mittr account changed. Open the settings again.' } });
  assert.equal(fetchImpl.calls.length, 0);
});

test('a save that names no account is refused and nothing is sent', async (t) => {
  const { call, fetchImpl } = await setUp(t);
  for (const body of [{ jira: {} }, { expectUserId: 7, jira: {} }, { expectUserId: '', jira: {} }]) {
    const reply = await call('PUT', '/api/mittr/integrations', body);
    assert.deepEqual(reply, { status: 400, body: { error: 'Invalid request body' } });
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('a save whose jira or plane is not an object is refused and nothing is sent', async (t) => {
  const { call, fetchImpl } = await setUp(t);
  for (const body of [{ expectUserId: 'u-a', jira: 'x' }, { expectUserId: 'u-a', plane: [1] }, { expectUserId: 'u-a', jira: null }]) {
    assert.deepEqual(await call('PUT', '/api/mittr/integrations', body), { status: 400, body: { error: 'Invalid request body' } });
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('a body that is too large or not JSON is refused and nothing is sent', async (t) => {
  const { call, fetchImpl } = await setUp(t);
  const large = await call('PUT', '/api/mittr/integrations', { expectUserId: 'u-a', jira: { note: 'x'.repeat(20_000) } });
  assert.deepEqual(large, { status: 413, body: { error: 'Invalid request body' } });
  const raw = await fetch(`${call.base}/api/mittr/integrations`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.equal(raw.status, 400);
  assert.equal(fetchImpl.calls.length, 0);
});

test('omitting the token keeps the saved one', async (t) => {
  const { call, fetchImpl } = await setUp(t);
  const jira = { baseUrl: 'https://y.atlassian.net', email: 'b@y' };
  await call('PUT', '/api/mittr/integrations', { expectUserId: 'u-a', jira });
  assert.deepEqual(fetchImpl.calls[0].body, { jira });
  assert.equal(Object.hasOwn(fetchImpl.calls[0].body.jira, 'token'), false);
});

test('the token never reaches the log or the reply, and the module cannot write a file', async (t) => {
  const refusals = [json({ error: 'Bad Request', message: 'Invalid base URL' }, 400), new Response('<html>nope</html>', { status: 502 })];
  const fetchImpl = fakeFetch((_call, n) => (n === 1 ? json(CONFIG) : n === 2 ? json({ ok: true, displayName: 'A' }) : refusals[n - 3] ?? json(CONFIG)));
  const { call, logger } = await setUp(t, { fetchImpl });
  const body = {
    expectUserId: 'u-a',
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@x', token: JIRA_SECRET },
    plane: { baseUrl: 'https://plane.example', workspaceSlug: 'mittr', apiKey: PLANE_SECRET },
  };
  const replies = [
    await call('PUT', '/api/mittr/integrations', body),
    await call('POST', '/api/mittr/integrations/jira/test'),
    await call('PUT', '/api/mittr/integrations', body),
    await call('PUT', '/api/mittr/integrations', body),
  ];
  assert.equal(replies[0].body.jira.hasToken, true);
  assert.equal(replies[0].body.plane.hasApiKey, true);
  for (const secret of [JIRA_SECRET, PLANE_SECRET, ACCESS]) {
    assert.equal(JSON.stringify(replies).includes(secret), false, `a reply carries ${secret}`);
    assert.equal(logger.lines.some((line) => line.includes(secret)), false, `the log carries ${secret}`);
  }
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'integrations-routes.js'), 'utf8');
  assert.doesNotMatch(source, /node:fs|writeFile|appendFile|localStorage/);
});

test('a platform reply that echoes secrets has them dropped from the config', async (t) => {
  const echoed = {
    jira: { ...CONFIG.jira, token: JIRA_SECRET, webhookPath: '/hooks/jira/abc' },
    plane: { ...CONFIG.plane, apiKey: PLANE_SECRET, hasWebhookSecret: true, webhookPath: '/hooks/plane/abc' },
  };
  const { call } = await setUp(t, { fetchImpl: fakeFetch(() => json(echoed)) });
  const expected = { ...CONFIG, userId: 'u-a' };
  assert.deepEqual((await call('GET', '/api/mittr/integrations')).body, expected);
  const saved = await call('PUT', '/api/mittr/integrations', { expectUserId: 'u-a', jira: { email: 'a@x' } });
  assert.deepEqual(saved.body, expected);
  const text = JSON.stringify([expected, saved.body]);
  for (const name of [JIRA_SECRET, PLANE_SECRET, 'hasWebhookSecret', 'webhookPath']) assert.equal(text.includes(name), false, name);
});

test('workspaceSlugs is answered only when the platform sends a list', async (t) => {
  for (const workspaceSlugs of ['mittr', null, { 0: 'mittr' }]) {
    const { call } = await setUp(t, { fetchImpl: fakeFetch(() => json({ ...CONFIG, plane: { ...CONFIG.plane, workspaceSlugs } })) });
    assert.equal(Object.hasOwn((await call('GET', '/api/mittr/integrations')).body.plane, 'workspaceSlugs'), false);
  }
});

test('PUT forwards only the known fields of jira and plane, and never a webhook secret', async (t) => {
  const { call, fetchImpl } = await setUp(t);
  await call('PUT', '/api/mittr/integrations', {
    expectUserId: 'u-a',
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@x', token: JIRA_SECRET, webhookSecret: 'hook-1', hasToken: false, configured: false },
    plane: { baseUrl: 'https://plane.example', workspaceSlug: 'mittr', workspaceSlugs: ['mittr', 'craft'], apiKey: PLANE_SECRET, webhookSecret: 'hook-2', hasApiKey: false, webhookPath: '/x' },
  });
  assert.deepEqual(fetchImpl.calls[0].body, {
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@x', token: JIRA_SECRET },
    plane: { baseUrl: 'https://plane.example', workspaceSlug: 'mittr', workspaceSlugs: ['mittr', 'craft'], apiKey: PLANE_SECRET },
  });
  assert.equal(JSON.stringify(fetchImpl.calls[0].body).includes('hook-'), false);
});

test('a partial block is forwarded without the fields it leaves out', async (t) => {
  const { call, fetchImpl } = await setUp(t);
  await call('PUT', '/api/mittr/integrations', { expectUserId: 'u-a', jira: { email: 'a@x', token: undefined }, plane: { workspaceSlugs: ['mittr'] } });
  assert.deepEqual(fetchImpl.calls[0].body, { jira: { email: 'a@x' }, plane: { workspaceSlugs: ['mittr'] } });
});

test('the Jira test passes the platform result through with the account', async (t) => {
  const result = { ok: true, displayName: 'Ada', email: 'a@x' };
  const { call, fetchImpl } = await setUp(t, { fetchImpl: fakeFetch(() => json(result)) });
  const reply = await call('POST', '/api/mittr/integrations/jira/test');
  assert.deepEqual(reply, { status: 200, body: { ...result, userId: 'u-a' } });
  assert.equal(fetchImpl.calls[0].url, 'https://api-dev.mittr.asia/api/integrations/jira/test');
  assert.equal(fetchImpl.calls[0].method, 'POST');
  assert.equal(fetchImpl.calls[0].body, undefined);
});

test('the Plane test passes per-workspace results through', async (t) => {
  const result = {
    ok: false,
    error: 'craft: 401',
    workspaces: [
      { slug: 'mittr', ok: true, count: 4, projects: [{ id: 'p1', name: 'Mittr' }] },
      { slug: 'craft', ok: false, error: 'Invalid API key' },
    ],
  };
  const { call, fetchImpl } = await setUp(t, { fetchImpl: fakeFetch(() => json(result)) });
  const reply = await call('POST', '/api/mittr/integrations/plane/test');
  assert.deepEqual(reply, { status: 200, body: { ...result, userId: 'u-a' } });
  assert.equal(fetchImpl.calls[0].url, 'https://api-dev.mittr.asia/api/integrations/plane/test');
});

test('a platform without workspaceSlugs passes its single slug through unchanged', async (t) => {
  const single = {
    jira: CONFIG.jira,
    plane: { baseUrl: 'https://plane.example', workspaceSlug: 'mittr', hasApiKey: true, configured: true },
  };
  const { call } = await setUp(t, { fetchImpl: fakeFetch(() => json(single)) });
  const reply = await call('GET', '/api/mittr/integrations');
  assert.deepEqual(reply.body, { ...single, userId: 'u-a' });
  assert.equal(Object.hasOwn(reply.body.plane, 'workspaceSlugs'), false);
  const plane = { ok: true, count: 2, projects: [{ id: 'p1', name: 'Mittr' }] };
  const tested = await setUp(t, { fetchImpl: fakeFetch(() => json(plane)) });
  assert.deepEqual((await tested.call('POST', '/api/mittr/integrations/plane/test')).body, { ...plane, userId: 'u-a' });
});

test('nobody signed in answers 401 and asks the platform nothing', async (t) => {
  for (const session of [null, {}, { accessToken: '' }]) {
    const { call, fetchImpl } = await setUp(t, { ensureFreshSession: async () => session });
    for (const [method, route, body] of [
      ['GET', '/api/mittr/integrations'],
      ['PUT', '/api/mittr/integrations', { expectUserId: 'u-a', jira: {} }],
      ['POST', '/api/mittr/integrations/jira/test'],
      ['POST', '/api/mittr/integrations/plane/test'],
    ]) {
      assert.deepEqual(await call(method, route, body), { status: 401, body: { error: 'Sign in to Mittr first' } }, route);
    }
    assert.equal(fetchImpl.calls.length, 0);
  }
});

test('no broker answers 503 and asks nobody anything', async (t) => {
  let asked = 0;
  const { call, fetchImpl } = await setUp(t, { broker: null, ensureFreshSession: async () => { asked += 1; return sessionOf('u-a'); } });
  for (const [method, route] of [['GET', '/api/mittr/integrations'], ['POST', '/api/mittr/integrations/jira/test']]) {
    assert.deepEqual(await call(method, route), { status: 503, body: { error: 'Mittr platform is not reachable from this install' } });
  }
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(asked, 0);
});

test('a platform refusal passes its status and its text through', async (t) => {
  const cases = [
    [json({ error: 'Invalid base URL' }, 400), 400, 'Invalid base URL'],
    [json({ statusCode: 400, error: 'Bad Request', message: 'baseUrl must be a URL' }, 400), 400, 'baseUrl must be a URL'],
    [json({ error: 'Forbidden' }, 403), 403, 'HTTP 403'],
    [new Response('<html></html>', { status: 404 }), 404, 'HTTP 404'],
    [json({ message: 'Down for maintenance' }, 503), 503, 'Down for maintenance'],
    [json({ error: 'boom' }, 500), 500, 'boom'],
  ];
  for (const [response, status, error] of cases) {
    const { call, logger } = await setUp(t, { fetchImpl: fakeFetch(() => response) });
    assert.deepEqual(await call('GET', '/api/mittr/integrations'), { status, body: { error } });
    assert.deepEqual(logger.lines, []);
  }
});

test('a platform refusal of a test passes through too', async (t) => {
  const { call } = await setUp(t, { fetchImpl: fakeFetch(() => json({ error: 'Jira is not configured' }, 400)) });
  assert.deepEqual(await call('POST', '/api/mittr/integrations/jira/test'), { status: 400, body: { error: 'Jira is not configured' } });
});

test('a timeout answers 504 and a network failure answers 502, and the log names the route and status only', async (t) => {
  const slow = await setUp(t, { fetchImpl: fakeFetch(() => { throw new DOMException('The operation timed out', 'TimeoutError'); }) });
  assert.deepEqual(await slow.call('GET', '/api/mittr/integrations'), { status: 504, body: { error: PLATFORM_TIMED_OUT } });
  assert.deepEqual(slow.logger.lines, ['[mittr] work tracking request failed: GET /api/mittr/integrations 504']);

  const down = await setUp(t, { fetchImpl: fakeFetch(() => { throw new TypeError('fetch failed https://api-dev.mittr.asia'); }) });
  assert.deepEqual(await down.call('POST', '/api/mittr/integrations/plane/test'), { status: 502, body: { error: CANNOT_REACH_MITTR } });
  assert.deepEqual(down.logger.lines, ['[mittr] work tracking request failed: POST /api/mittr/integrations/plane/test 502']);
});

test('a session that cannot be refreshed answers a plain failure and logs the route and status only', async (t) => {
  const { call, logger } = await setUp(t, { ensureFreshSession: async () => { throw new Error(`keychain locked ${JIRA_SECRET}`); } });
  assert.deepEqual(await call('PUT', '/api/mittr/integrations', { expectUserId: 'u-a', jira: { token: JIRA_SECRET } }), { status: 500, body: { error: 'Request failed' } });
  assert.deepEqual(logger.lines, ['[mittr] work tracking request failed: PUT /api/mittr/integrations 500']);
});

test('a reply that is not JSON still names the account', async (t) => {
  const { call } = await setUp(t, { fetchImpl: fakeFetch(() => new Response('ok', { status: 200 })) });
  assert.deepEqual(await call('GET', '/api/mittr/integrations'), { status: 200, body: { userId: 'u-a' } });
  assert.deepEqual(await call('POST', '/api/mittr/integrations/jira/test'), { status: 200, body: { userId: 'u-a' } });
});

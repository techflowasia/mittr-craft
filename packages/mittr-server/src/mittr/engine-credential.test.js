import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureMittrCredential, forgetMittrCredential } from './engine-credential.js';
import { fakeEngineFetch } from './test-helpers.js';

const KEY = `mc_local_${'ab'.repeat(32)}`;
const NEXT_KEY = `mc_local_${'cd'.repeat(32)}`;

const fakeEngine = (port = 4096) => {
  const engine = {
    port,
    url: (route = '/') => {
      if (engine.port === null) throw new Error('OpenCode port is not available');
      return `http://127.0.0.1:${engine.port}${route.startsWith('/') ? route : `/${route}`}`;
    },
    authHeaders: () => ({ Authorization: 'Basic b3BlbmNvZGU6cHc=' }),
    defaultDirectory: () => '/Users/someone/my project',
  };
  return engine;
};

const noWait = async () => {};
const keyEntry = (id, integrationID, key, active) => ({ id, integrationID, label: id, active, value: { type: 'key', key } });

test('credential is stored once per engine start', async () => {
  const opencode = fakeEngine(4096);
  const fetchImpl = fakeEngineFetch();

  assert.equal(await ensureMittrCredential({ opencode, key: KEY, fetchImpl }), 'stored');
  assert.equal(await ensureMittrCredential({ opencode, key: KEY, fetchImpl }), 'present');
  assert.equal(fetchImpl.connects().length, 1);
  const [call] = fetchImpl.connects();
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'http://127.0.0.1:4096/api/integration/mittr/connect/key');
  assert.deepEqual(call.body, { key: KEY });
  assert.equal(call.headers.Authorization, 'Basic b3BlbmNvZGU6cHc=');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.headers['x-opencode-directory'], encodeURIComponent('/Users/someone/my project'));

  opencode.port = 4200;
  assert.equal(await ensureMittrCredential({ opencode, key: KEY, fetchImpl }), 'stored');
  assert.equal(fetchImpl.connects().length, 2);
  assert.equal(fetchImpl.connects()[1].url, 'http://127.0.0.1:4200/api/integration/mittr/connect/key');
});

test('a new key for the same engine is stored', async () => {
  const opencode = fakeEngine();
  const fetchImpl = fakeEngineFetch();
  await ensureMittrCredential({ opencode, key: KEY, fetchImpl });
  assert.equal(await ensureMittrCredential({ opencode, key: NEXT_KEY, fetchImpl }), 'stored');
  assert.deepEqual(fetchImpl.connects().map((call) => call.body.key), [KEY, NEXT_KEY]);
});

test('an engine restarted on the same port is given the key again once forgotten', async () => {
  const opencode = fakeEngine(4096);
  const fetchImpl = fakeEngineFetch();
  await ensureMittrCredential({ opencode, key: KEY, fetchImpl });
  forgetMittrCredential(opencode);
  assert.equal(await ensureMittrCredential({ opencode, key: KEY, fetchImpl }), 'stored');
  assert.equal(fetchImpl.connects().length, 2);
});

test('the Mittr keys of earlier runs and starts are removed; other providers keep theirs', async () => {
  const opencode = fakeEngine();
  const fetchImpl = fakeEngineFetch({
    entries: [
      keyEntry('cred_old_run', 'mittr', `mc_local_${'00'.repeat(32)}`, true),
      keyEntry('cred_openai', 'openai', 'sk-user', true),
    ],
  });
  await ensureMittrCredential({ opencode, key: KEY, fetchImpl });
  forgetMittrCredential(opencode);
  await ensureMittrCredential({ opencode, key: KEY, fetchImpl });

  assert.deepEqual(
    fetchImpl.store.map(({ integrationID, active, value }) => ({ integrationID, active, key: value.key })),
    [{ integrationID: 'openai', active: true, key: 'sk-user' }, { integrationID: 'mittr', active: true, key: KEY }],
  );
  const removals = fetchImpl.calls.filter((call) => call.method === 'DELETE').map((call) => new URL(call.url).pathname);
  assert.deepEqual(removals, ['/api/credential/cred_old_run', '/api/credential/cred_3']);
  assert.equal(fetchImpl.calls.filter((call) => call.method === 'DELETE').every((call) => call.headers.Authorization === 'Basic b3BlbmNvZGU6cHc='), true);
});

test('an old key the engine keeps is reported, and the next call tries again', async () => {
  const opencode = fakeEngine();
  let refuseRemoval = true;
  const fetchImpl = fakeEngineFetch({
    entries: [keyEntry('cred_old_run', 'mittr', `mc_local_${'00'.repeat(32)}`, true)],
    answer: (call) => (call.method === 'DELETE' && refuseRemoval ? new Response(null, { status: 500 }) : null),
  });
  await assert.rejects(ensureMittrCredential({ opencode, key: KEY, fetchImpl }), /kept 1 old Mittr key/);
  refuseRemoval = false;
  assert.equal(await ensureMittrCredential({ opencode, key: KEY, fetchImpl }), 'stored');
  assert.deepEqual(fetchImpl.store.map((entry) => entry.value.key), [KEY]);
});

test('a key the engine does not list as active is not counted as stored', async () => {
  const opencode = fakeEngine();
  const fetchImpl = fakeEngineFetch({
    answer: (call) => (call.url.endsWith('/api/credential') ? new Response(JSON.stringify({ data: [] }), { status: 200 }) : null),
  });
  await assert.rejects(ensureMittrCredential({ opencode, key: KEY, fetchImpl }), /active/);
  assert.equal(fetchImpl.calls.filter((call) => call.method === 'DELETE').length, 0);
});

test('a key list in an unknown shape removes nothing', async () => {
  const opencode = fakeEngine();
  const fetchImpl = fakeEngineFetch({
    answer: (call) => (call.url.endsWith('/api/credential') ? new Response(JSON.stringify([]), { status: 200 }) : null),
  });
  await assert.rejects(ensureMittrCredential({ opencode, key: KEY, fetchImpl }), /shape/);
  assert.equal(fetchImpl.calls.filter((call) => call.method === 'DELETE').length, 0);
});

test('without a default directory the request carries no directory header', async () => {
  const opencode = { ...fakeEngine(), defaultDirectory: () => null };
  const fetchImpl = fakeEngineFetch();
  await ensureMittrCredential({ opencode, key: KEY, fetchImpl });
  assert.equal('x-opencode-directory' in fetchImpl.connects()[0].headers, false);
});

test('a provider the engine has not picked up yet is asked again, briefly', async () => {
  const opencode = fakeEngine();
  const waits = [];
  let refusals = 2;
  const fetchImpl = fakeEngineFetch({
    answer: (call) => {
      if (!call.url.endsWith('/connect/key') || refusals === 0) return null;
      refusals -= 1;
      return new Response('Integration not found', { status: 404 });
    },
  });
  const outcome = await ensureMittrCredential({ opencode, key: KEY, fetchImpl, wait: async (ms) => { waits.push(ms); } });
  assert.equal(outcome, 'stored');
  assert.equal(fetchImpl.connects().length, 3);
  assert.deepEqual(waits, [250, 500]);
});

test('a provider that never appears fails after the last wait, and is not remembered', async () => {
  const opencode = fakeEngine();
  const fetchImpl = fakeEngineFetch({ answer: (call) => (call.url.endsWith('/connect/key') ? new Response('Integration not found', { status: 404 }) : null) });
  await assert.rejects(ensureMittrCredential({ opencode, key: KEY, fetchImpl, wait: noWait }), /404/);
  assert.equal(fetchImpl.connects().length, 5);
  const later = fakeEngineFetch();
  assert.equal(await ensureMittrCredential({ opencode, key: KEY, fetchImpl: later }), 'stored');
});

test('a refusal is not retried and its message never carries the key', async () => {
  const opencode = fakeEngine();
  const fetchImpl = fakeEngineFetch({ answer: (call) => (call.url.endsWith('/connect/key') ? new Response('bad', { status: 400 }) : null) });
  await assert.rejects(ensureMittrCredential({ opencode, key: KEY, fetchImpl, wait: noWait }), (error) => {
    assert.match(error.message, /400/);
    assert.equal(error.message.includes(KEY), false);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
});

test('an engine with no port yet fails without a request', async () => {
  const opencode = fakeEngine(null);
  const fetchImpl = fakeEngineFetch();
  await assert.rejects(ensureMittrCredential({ opencode, key: KEY, fetchImpl }), /port/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('each request is bounded by a timeout signal', async () => {
  const opencode = fakeEngine();
  const fetchImpl = fakeEngineFetch({ entries: [keyEntry('cred_old_run', 'mittr', 'old', false)] });
  await ensureMittrCredential({ opencode, key: KEY, fetchImpl });
  assert.equal(fetchImpl.calls.length, 3);
  assert.ok(fetchImpl.calls.every((call) => call.signal instanceof AbortSignal));
});

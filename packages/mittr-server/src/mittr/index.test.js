import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { setupMittr } from './index.js';
import { deferred, fakeEngineContext, fakeEngineFetch, fakeFetch, json, serve, tempDataDir, until } from './test-helpers.js';

const NOW = Date.now();
const DEV_ENV = { MITTRCRAFT_BROKER_URL: 'https://api-dev.mittr.asia', MITTRCRAFT_DEEP_LINK_SCHEME: 'mittrcraft-dev' };

const session = { accessToken: 'at-1', refreshToken: 'r1', expiresAt: NOW + 3_600_000, subject: { userId: 'u-a', displayName: 'A' } };

const sealingStore = () => ({
  encrypt: (text) => Buffer.from(Buffer.from(text, 'utf8').toString('base64'), 'utf8').reverse(),
  decrypt: (data) => Buffer.from(Buffer.from(data).reverse().toString('utf8'), 'base64').toString('utf8'),
});

const recordingLogger = () => {
  const lines = [];
  const warnings = [];
  const errors = [];
  return { lines, warnings, errors, log: (...args) => lines.push(args.join(' ')), warn: (...args) => warnings.push(args.join(' ')), error: (...args) => errors.push(args.join(' ')) };
};

const deepLinkHost = () => {
  const registrations = [];
  let unregistered = 0;
  return {
    registrations,
    unregistered: () => unregistered,
    register: (registration) => {
      registrations.push(registration);
      return () => { unregistered += 1; };
    },
  };
};

// The server parses JSON for every path outside `/api` before plugin routes
// run, and leaves `/api` bodies to each route.
const serverLikeApp = () => {
  const app = express();
  const parseJson = express.json({ limit: '50mb' });
  app.use((req, res, next) => (req.path.startsWith('/api') ? next() : parseJson(req, res, next)));
  return app;
};

const setUp = async (t, { host = null, env = DEV_ENV, fetchImpl = fakeFetch(() => json(session)), dataDir = tempDataDir(t), engine = fakeEngineContext(), sharedHistoryExists } = {}) => {
  const app = serverLikeApp();
  const logger = recordingLogger();
  const mittr = setupMittr({ app, express, dataDir, logger, host, ...engine.context }, { env, fetchImpl, sharedHistoryExists });
  t.after(() => mittr.dispose());
  return { mittr, dataDir, logger, fetchImpl, engine, call: await serve(t, app) };
};

const signIn = async (call) => {
  await call('POST', '/api/mittr/auth/start');
  return call('POST', '/api/mittr/auth/callback', { url: 'mittrcraft-dev://auth/callback?code=c1' });
};

const sessionFiles = (dataDir) => fs.readdirSync(path.join(dataDir, 'mittr-accounts')).filter((name) => name.endsWith('.session'));

test('scheme defaults to mittrcraft when unset', async (t) => {
  const { call } = await setUp(t, { env: { MITTRCRAFT_BROKER_URL: 'https://api-dev.mittr.asia' } });
  const { body } = await call('POST', '/api/mittr/auth/start');
  assert.ok(body.authorizeUrl.includes('redirect_uri=mittrcraft%3A%2F%2Fauth%2Fcallback'), body.authorizeUrl);
});

test('tokens are never written in plain text when a store is given', async (t) => {
  const deepLinks = deepLinkHost();
  const { call, dataDir, logger } = await setUp(t, { host: { secretStore: sealingStore(), deepLinks } });
  assert.equal((await signIn(call)).status, 200);
  const [file] = sessionFiles(dataDir);
  const bytes = fs.readFileSync(path.join(dataDir, 'mittr-accounts', file));
  assert.equal(bytes.includes('r1'), false);
  assert.equal(bytes.includes('at-1'), false);
  assert.deepEqual(logger.warnings, []);
});

test('deep-link auth handler completes sign-in and asks for the signed-in event', async (t) => {
  const deepLinks = deepLinkHost();
  const { mittr, call, fetchImpl } = await setUp(t, { host: { secretStore: sealingStore(), deepLinks } });
  assert.deepEqual(deepLinks.registrations.map((registration) => registration.host), ['auth']);
  await call('POST', '/api/mittr/auth/start');

  const result = await deepLinks.registrations[0].handle({ type: 'auth', value: 'callback', raw: 'mittrcraft-dev://auth/callback?code=c1' });

  assert.deepEqual(result, { emit: 'mittrcraft:signed-in' });
  assert.deepEqual(fetchImpl.calls.filter((entry) => entry.url.endsWith('/auth/desktop/exchange')).map((entry) => entry.body.code), ['c1']);
  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: true, userId: 'u-a', displayName: 'A' });

  await mittr.dispose();
  assert.equal(deepLinks.unregistered(), 1);
});

test('a deep-link sign-in that fails is logged and asks for the failed event, so the window can show it', async (t) => {
  const deepLinks = deepLinkHost();
  const { call, logger } = await setUp(t, { host: { secretStore: sealingStore(), deepLinks } });

  const result = await deepLinks.registrations[0].handle({ type: 'auth', raw: 'mittrcraft-dev://auth/callback?code=c2' });

  assert.deepEqual(result, { emit: 'mittrcraft:sign-in-failed' });
  assert.deepEqual(logger.warnings, ['[mittr] sign-in from the browser did not finish: No sign-in is in progress']);
  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: false, signInFailed: 'failed' });
});

test('a desktop without a keychain refuses sign-in and leaves the stored tokens alone', async (t) => {
  const deepLinks = deepLinkHost();
  const dataDir = tempDataDir(t);
  const sealed = sealingStore();
  const keyed = express();
  setupMittr({ app: keyed, express, dataDir, logger: recordingLogger(), host: { secretStore: sealed, deepLinks }, ...fakeEngineContext().context }, { env: DEV_ENV, fetchImpl: fakeFetch(() => json(session)) });
  assert.equal((await signIn(await serve(t, keyed))).status, 200);
  const snapshot = () => fs.readdirSync(path.join(dataDir, 'mittr-accounts')).map((name) => [name, fs.readFileSync(path.join(dataDir, 'mittr-accounts', name), 'utf8')]);
  const before = snapshot();

  const app = express();
  const logger = recordingLogger();
  const fetchImpl = fakeFetch(() => json(session));
  setupMittr({ app, express, dataDir, logger, host: { secretStore: null, deepLinks: deepLinkHost() }, ...fakeEngineContext().context }, { env: DEV_ENV, fetchImpl });
  const call = await serve(t, app);

  const refusal = { status: 503, body: { error: "MittrCraft can't find a secure keychain on this computer to keep your sign-in safe." } };
  assert.deepEqual(await call('POST', '/api/mittr/auth/start'), refusal);
  assert.deepEqual(await call('POST', '/api/mittr/auth/callback', { url: 'mittrcraft-dev://auth/callback?code=c1' }), refusal);
  assert.deepEqual(await call('DELETE', '/api/mittr/auth/session'), refusal);
  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: false, keychainMissing: true });
  assert.equal(fetchImpl.calls.length, 0);
  assert.deepEqual(logger.warnings, []);
  assert.deepEqual(snapshot(), before);
});

test('without a desktop host tokens are kept in a private plain file, with one warning', async (t) => {
  const { call, dataDir, logger } = await setUp(t, { host: null });
  assert.equal((await signIn(call)).status, 200);
  assert.deepEqual(logger.warnings, ['[mittr] no keychain: Mittr tokens are stored unencrypted']);
  const [file] = sessionFiles(dataDir);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dataDir, 'mittr-accounts', file)).mode & 0o777, 0o600);
});

const LOCKED = [
  { action: 'provider.use', resource: '*', effect: 'deny' },
  { action: 'provider.use', resource: 'mittr', effect: 'allow' },
];

test('setup hands the server plugin an engine env, a config fragment and a bounded dispose', async (t) => {
  const { mittr, engine } = await setUp(t);
  assert.deepEqual(await mittr.engineEnv(), { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' });
  assert.deepEqual(await mittr.managedConfig(), { experimental: { policies: LOCKED } });
  await mittr.dispose();
  assert.equal(engine.readyListeners.size, 0);
});

test('a damaged account list is logged with its path through the server logger, never sent to the client', async (t) => {
  const { call, dataDir, logger } = await setUp(t);
  const indexFile = path.join(dataDir, 'mittr-accounts', 'index.json');
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  fs.writeFileSync(indexFile, '[]');

  const status = await call('GET', '/api/mittr/auth/status');
  const start = await call('POST', '/api/mittr/auth/start');

  assert.deepEqual(status.body, { signedIn: false, accountsDamaged: true });
  assert.equal(start.status, 503);
  assert.equal(JSON.stringify([status.body, start.body]).includes(dataDir), false);
  assert.ok(logger.errors.some((line) => line.includes(indexFile)), logger.errors.join('\n'));
});

const SHIM_TOKEN = /^mc_local_[0-9a-f]{64}$/;
const shimKey = (dataDir) => fs.readFileSync(path.join(dataDir, 'mittr-shim-token'), 'utf8');
const askShim = (call, key, body = { model: 'gpt-a', stream: false, messages: [] }) => fetch(`${call.base}/mittr-shim/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify(body),
});

test('the shim is mounted with a key of its own, and hands Mittr the account token', async (t) => {
  const answer = { choices: [{ message: { role: 'assistant', content: 'hi' } }] };
  const fetchImpl = fakeFetch((request) => json(request.url.endsWith('/chat/completions') ? answer : session));
  const { call, dataDir } = await setUp(t, { fetchImpl });
  const key = shimKey(dataDir);
  assert.match(key, SHIM_TOKEN);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dataDir, 'mittr-shim-token')).mode & 0o777, 0o600);

  const signedOut = await askShim(call, key);
  assert.equal(signedOut.status, 401);
  assert.deepEqual(await signedOut.json(), { error: 'Not signed in to Mittr. Sign in to continue.' });

  assert.equal((await signIn(call)).status, 200);
  const response = await askShim(call, key);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), answer);
  const upstream = fetchImpl.calls.at(-1);
  assert.equal(upstream.url, 'https://api-dev.mittr.asia/v1/chat/completions');
  assert.equal(upstream.headers.authorization, 'Bearer at-1');
  assert.equal(JSON.stringify(upstream).includes(key), false);
});

test('each run mints a new shim key, and the last run\'s key no longer opens the shim', async (t) => {
  const dataDir = tempDataDir(t);
  const first = await setUp(t, { dataDir });
  const oldKey = shimKey(dataDir);
  const second = await setUp(t, { dataDir });
  const newKey = shimKey(dataDir);
  assert.notEqual(newKey, oldKey);
  assert.equal((await askShim(second.call, oldKey)).status, 401);
  assert.equal((await askShim(second.call, newKey)).status, 401);
  assert.deepEqual(await (await askShim(second.call, newKey)).json(), { error: 'Not signed in to Mittr. Sign in to continue.' });
  assert.ok(first.call);
});

test('a sign-out while a refresh is in flight answers the engine 401 and calls nobody', async (t) => {
  const expiring = { ...session, expiresAt: Date.now() + 30_000 };
  const refresh = deferred();
  const refreshAsked = deferred();
  const fetchImpl = fakeFetch((request) => {
    if (request.url.endsWith('/auth/desktop/refresh')) {
      refreshAsked.resolve();
      return refresh.promise;
    }
    return json(expiring);
  });
  const { call, dataDir } = await setUp(t, { fetchImpl });
  assert.equal((await signIn(call)).status, 200);

  const pending = askShim(call, shimKey(dataDir));
  await refreshAsked.promise;
  assert.equal((await call('DELETE', '/api/mittr/auth/session')).status, 200);
  refresh.resolve(json({ ...session, accessToken: 'at-2', refreshToken: 'r2' }));

  const response = await pending;
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Not signed in to Mittr. Sign in to continue.' });
  assert.equal(fetchImpl.calls.some((request) => request.url.endsWith('/chat/completions')), false);
  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: false });
});

// How the engine's side of a stream ends within two seconds: cut, ended as if
// complete, or still open. A regression then fails instead of hanging.
const streamOutcome = async (reader) => Promise.race([
  (async () => {
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read());
      return 'ended';
    } catch {
      return 'cut';
    }
  })(),
  new Promise((resolve) => { setTimeout(() => resolve('still open'), 2_000); }),
]);

// A Mittr answer that sends one part and then waits, until its request is aborted.
const heldStream = () => {
  const aborted = deferred();
  const respond = (signal) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'));
      signal?.addEventListener('abort', () => {
        aborted.resolve('aborted');
        controller.error(new Error('aborted'));
      });
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  return { respond, aborted: aborted.promise };
};

test('signing out ends an answer still streaming on that account', async (t) => {
  const held = heldStream();
  const fetchImpl = fakeFetch((request) => (request.url.endsWith('/chat/completions') ? held.respond(request.signal) : json(session)));
  const { call, dataDir, logger } = await setUp(t, { fetchImpl });
  assert.equal((await signIn(call)).status, 200);

  const response = await askShim(call, shimKey(dataDir), { model: 'gpt-a', stream: true, messages: [] });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  await reader.read();

  assert.equal((await call('DELETE', '/api/mittr/auth/session')).status, 200);
  assert.equal(await streamOutcome(reader), 'cut');
  assert.equal(await Promise.race([held.aborted, new Promise((resolve) => { setTimeout(() => resolve('still streaming'), 2_000); })]), 'aborted');
  assert.ok(logger.warnings.includes('[mittr] shim ended 1 answer(s): the Mittr account changed'), logger.warnings.join('\n'));
});

const MODELS = [{ alias: 'a1', label: 'Writer' }, { alias: 'a2', label: '' }];
const engineCalls = (fetchImpl) => fetchImpl.calls.filter((call) => call.url.includes('/api/integration/'));
const engineAndBroker = (answer) => fakeEngineFetch({ answer, other: () => json(session) });

test('the lock is in the config from the first build, before any model or port', async (t) => {
  const engine = fakeEngineContext({ port: null });
  const { mittr } = await setUp(t, { engine });
  assert.deepEqual(await mittr.managedConfig(), { experimental: { policies: LOCKED } });
});

test('the stored switch ON still denies the hosted opencode provider', async (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(path.join(dataDir, 'mittr-settings.json'), JSON.stringify({ showOtherProviders: true }));
  const { mittr } = await setUp(t, { dataDir });
  assert.deepEqual(await mittr.managedConfig(), {
    experimental: { policies: [{ action: 'provider.use', resource: 'opencode', effect: 'deny' }] },
  });
});

test('the shim URL follows the bound server port', async (t) => {
  const engine = fakeEngineContext({ port: 4100 });
  const { mittr } = await setUp(t, { engine, fetchImpl: engineAndBroker() });
  await mittr.applyModels(MODELS);

  const config = await mittr.managedConfig();
  assert.equal(config.providers.mittr.settings.baseURL, 'http://127.0.0.1:4100/mittr-shim/v1');
  assert.deepEqual(Object.keys(config.providers.mittr.models), ['a1', 'a2']);
  assert.deepEqual(config.experimental.policies, LOCKED);

  engine.server.port = null;
  const unbound = await mittr.managedConfig();
  assert.equal(unbound.providers?.mittr, undefined);
  assert.deepEqual(unbound.experimental.policies, LOCKED);
});

test('new models rewrite the managed config, then hand the engine the shim key, never the Mittr token', async (t) => {
  const engine = fakeEngineContext();
  const fetchImpl = engineAndBroker();
  const { mittr, dataDir } = await setUp(t, { engine, fetchImpl });
  engine.fireReady();
  await mittr.applyModels(MODELS);

  assert.equal(engine.refreshes.length, 1);
  const [post] = engineCalls(fetchImpl);
  assert.equal(post.url, 'http://127.0.0.1:4096/api/integration/mittr/connect/key');
  assert.deepEqual(post.body, { key: shimKey(dataDir) });
  assert.equal(JSON.stringify(post).includes('at-1'), false);
  assert.deepEqual(engine.restarts, []);
});

test('with no models the engine is not asked to store a key', async (t) => {
  const fetchImpl = engineAndBroker();
  const { engine } = await setUp(t, { fetchImpl });
  engine.fireReady();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(engineCalls(fetchImpl).length, 0);
});

test('credential runs on every ready', async (t) => {
  const engine = fakeEngineContext({ enginePort: 4096 });
  const fetchImpl = engineAndBroker();
  const { mittr, logger } = await setUp(t, { engine, fetchImpl });
  engine.fireReady();
  await mittr.applyModels(MODELS);
  assert.equal(engineCalls(fetchImpl).length, 1);

  const storedLines = () => logger.lines.filter((line) => line.includes('has its Mittr key')).length;
  await until(() => storedLines() === 1);

  engine.engine.port = 4200;
  engine.fireReady();
  await until(() => storedLines() === 2);
  engine.engine.port = 4300;
  engine.fireReady();
  await until(() => storedLines() === 3);
  assert.deepEqual(engineCalls(fetchImpl).map((call) => new URL(call.url).port), ['4096', '4200', '4300']);

  // A restart on a fixed port is a new engine too, and may run on another account's database.
  engine.fireReady();
  await until(() => storedLines() === 4);
  assert.equal(engineCalls(fetchImpl).length, 4);
  assert.deepEqual(engine.restarts, []);
});

test('credential failure is reported, not thrown, and retried on next ready', async (t) => {
  const engine = fakeEngineContext();
  let refuse = true;
  const fetchImpl = engineAndBroker((call) => (refuse && call.url.endsWith('/connect/key') ? new Response('boom', { status: 500 }) : null));
  const { mittr, logger, dataDir } = await setUp(t, { engine, fetchImpl });

  engine.fireReady();
  await mittr.applyModels(MODELS);
  assert.equal(engineCalls(fetchImpl).length, 1);
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /\[mittr\].*500/);
  assert.equal(logger.warnings[0].includes(shimKey(dataDir)), false);

  refuse = false;
  engine.fireReady();
  await until(() => engineCalls(fetchImpl).length === 2);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(logger.warnings.length, 1);
});

test('a ready while the engine port is unknown is logged and does not throw into the server', async (t) => {
  const engine = fakeEngineContext();
  const fetchImpl = engineAndBroker();
  const { mittr, logger } = await setUp(t, { engine, fetchImpl });
  engine.fireReady();
  await mittr.applyModels(MODELS);
  engine.engine.port = null;
  assert.doesNotThrow(() => engine.fireReady());
  await until(() => logger.warnings.length === 1);
  assert.match(logger.warnings[0], /port/);
  assert.equal(engineCalls(fetchImpl).length, 1);
});

test('models set before the engine is first ready wait for that ready, with no warning', async (t) => {
  const engine = fakeEngineContext();
  const fetchImpl = engineAndBroker();
  const { mittr, logger } = await setUp(t, { engine, fetchImpl });
  await mittr.applyModels(MODELS);
  assert.equal(engine.refreshes.length, 1);
  assert.equal(engineCalls(fetchImpl).length, 0);
  assert.deepEqual(logger.warnings, []);

  engine.fireReady();
  await until(() => engineCalls(fetchImpl).length === 1);
});

const CATALOG_A = { bundleVersion: 7, subject: { userId: 'u-a' }, models: [{ alias: 'a1', label: 'Writer' }, { alias: 'a2', label: 'Reader' }] };
const CATALOG_B = { bundleVersion: 4, subject: { userId: 'u-b' }, models: [{ alias: 'b1', label: 'Planner' }] };
const sessionB = { accessToken: 'at-b', refreshToken: 'rb', expiresAt: NOW + 3_600_000, subject: { userId: 'u-b', displayName: 'B' } };

const isCatalogCall = (request) => request.url.endsWith('/desktop/catalog');
const catalogCalls = (fetchImpl) => fetchImpl.calls.filter(isCatalogCall);

// Mittr as the platform answers it: each sign-in exchange hands out the next
// session, and the catalog follows the token it is asked with.
const platform = ({ sessions = [session], catalogs = { 'at-1': CATALOG_A, 'at-b': CATALOG_B }, catalog = null } = {}) => {
  let exchanges = 0;
  return fakeEngineFetch({
    other: (request) => {
      if (isCatalogCall(request)) {
        if (catalog) return catalog(request);
        return json(catalogs[request.headers.authorization.slice('Bearer '.length)]);
      }
      if (request.url.endsWith('/auth/desktop/exchange')) {
        exchanges += 1;
        return json(sessions[Math.min(exchanges, sessions.length) - 1]);
      }
      return json(session);
    },
  });
};

const mittrModelsOf = async (mittr) => Object.keys((await mittr.managedConfig()).providers?.mittr?.models ?? {});
const listShimModels = async (call, dataDir) => fetch(`${call.base}/mittr-shim/v1/models`, { headers: { authorization: `Bearer ${shimKey(dataDir)}` } });
const catalogFiles = (dataDir) => fs.readdirSync(path.join(dataDir, 'mittr-accounts')).filter((name) => name.endsWith('.catalog.json'));

test('a completed sign-in syncs the catalog into the account\'s own cache and the engine\'s models', async (t) => {
  const fetchImpl = platform();
  const { mittr, call, dataDir } = await setUp(t, { fetchImpl });
  assert.equal(catalogCalls(fetchImpl).length, 0);

  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 1);
  await until(() => fs.existsSync(path.join(dataDir, 'mittr-accounts')) && catalogFiles(dataDir).length === 1);
  await until(async () => (await mittrModelsOf(mittr)).length === 2);
  assert.deepEqual(await mittrModelsOf(mittr), ['a1', 'a2']);
  assert.equal(catalogCalls(fetchImpl)[0].headers.authorization, 'Bearer at-1');

  // Signing in again as the same person syncs again.
  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 2);
});

test('offline start applies the cached catalog', async (t) => {
  const dataDir = tempDataDir(t);
  const first = await setUp(t, { dataDir, fetchImpl: platform() });
  assert.equal((await signIn(first.call)).status, 200);
  await until(() => fs.existsSync(path.join(dataDir, 'mittr-accounts')) && catalogFiles(dataDir).length === 1);
  await first.mittr.dispose();

  const offline = deferred();
  const fetchImpl = platform({ catalog: () => offline.promise.then(() => { throw new Error('ECONNREFUSED'); }) });
  const { mittr, call, logger, engine } = await setUp(t, { dataDir, fetchImpl });
  await until(() => catalogCalls(fetchImpl).length === 1);
  assert.deepEqual(await mittrModelsOf(mittr), ['a1', 'a2']);
  // The engine has not started yet: its first config build reads these.
  assert.equal(engine.refreshes.length, 0);

  offline.resolve();
  await until(() => logger.errors.some((line) => line.includes('catalog sync failed')));
  assert.deepEqual(await mittrModelsOf(mittr), ['a1', 'a2']);
  const again = await call('POST', '/api/mittr/catalog/sync');
  assert.deepEqual(again, { status: 502, body: { error: 'Cannot reach Mittr' } });
});

test('an account switch applies that account\'s cache, then syncs', async (t) => {
  let held = null;
  const catalogs = { 'at-1': CATALOG_A, 'at-b': CATALOG_B };
  const fetchImpl = platform({
    sessions: [session, sessionB],
    catalog: (request) => {
      const answer = json(catalogs[request.headers.authorization.slice('Bearer '.length)]);
      return held ? held.promise.then(() => answer) : answer;
    },
  });
  const { mittr, call } = await setUp(t, { fetchImpl });
  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 1);
  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 2);
  await until(async () => (await mittrModelsOf(mittr)).join() === 'b1');

  held = deferred();
  assert.equal((await call('POST', '/api/mittr/auth/accounts/activate', { userId: 'u-a' })).status, 200);
  assert.deepEqual(await mittrModelsOf(mittr), ['a1', 'a2']);
  await until(() => catalogCalls(fetchImpl).length === 3);
  assert.equal(catalogCalls(fetchImpl).at(-1).headers.authorization, 'Bearer at-1');
  held.resolve();
});

test('the shim lists the active account\'s cached models', async (t) => {
  const fetchImpl = platform({ sessions: [session, sessionB] });
  const { call, dataDir } = await setUp(t, { fetchImpl });
  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 1);
  await until(() => fs.existsSync(path.join(dataDir, 'mittr-accounts')) && catalogFiles(dataDir).length === 1);

  const listed = await listShimModels(call, dataDir);
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).data.map((model) => model.id), ['a1', 'a2']);

  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogFiles(dataDir).length === 2);
  assert.deepEqual((await (await listShimModels(call, dataDir)).json()).data.map((model) => model.id), ['b1']);
});

test('with no catalog to read, the shim says the model list is unavailable instead of listing none', async (t) => {
  const fetchImpl = platform({ catalog: () => new Response('down', { status: 503 }) });
  const { call, dataDir } = await setUp(t, { fetchImpl });
  assert.equal((await listShimModels(call, dataDir)).status, 503);

  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 1);
  const unavailable = await listShimModels(call, dataDir);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: 'The Mittr model list is not available' });
});

test('signing out of the last account takes the Mittr models out of the engine config', async (t) => {
  const fetchImpl = platform();
  // The account on the shared history keeps its catalog at the shared path,
  // which outlives the sign-out.
  const { mittr, call, dataDir } = await setUp(t, { fetchImpl, sharedHistoryExists: () => false });
  assert.equal((await signIn(call)).status, 200);
  await until(async () => (await mittrModelsOf(mittr)).length === 2);
  assert.equal(fs.existsSync(path.join(dataDir, 'mittr-catalog.json')), true);

  assert.equal((await call('DELETE', '/api/mittr/auth/session')).status, 200);
  assert.deepEqual(await mittrModelsOf(mittr), []);
  assert.deepEqual((await call('GET', '/api/mittr/catalog')).body.bundleVersion, null);
});

test('a failing config refresh while applying models is logged, never thrown into the server', async (t) => {
  const engine = fakeEngineContext();
  engine.context.managedConfig.refresh = async () => { throw new Error('disk full'); };
  const fetchImpl = platform();
  const { call, logger } = await setUp(t, { engine, fetchImpl });
  assert.equal((await signIn(call)).status, 200);
  await until(() => logger.warnings.some((line) => line.includes('could not apply the Mittr models') && line.includes('disk full')));
  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body.signedIn, true);
});

test('a key the engine refused while models were applied is tried once more in the background', async (t) => {
  const engine = fakeEngineContext();
  let refusals = 1;
  const fetchImpl = engineAndBroker((request) => {
    if (request.url.endsWith('/connect/key') && refusals > 0) {
      refusals -= 1;
      return new Response('boom', { status: 500 });
    }
    return null;
  });
  const app = serverLikeApp();
  const logger = recordingLogger();
  const mittr = setupMittr({ app, express, dataDir: tempDataDir(t), logger, host: null, ...engine.context }, { env: DEV_ENV, fetchImpl, credentialRetryMs: 20 });
  t.after(() => mittr.dispose());

  engine.fireReady();
  await mittr.applyModels(MODELS);
  assert.equal(engineCalls(fetchImpl).length, 1);
  assert.equal(logger.warnings.length, 1);
  await until(() => logger.lines.some((line) => line.includes('has its Mittr key')));
  assert.equal(engineCalls(fetchImpl).length, 2);
});

test('the background key retry is tried only once, and dispose cancels it', async (t) => {
  const engine = fakeEngineContext();
  const fetchImpl = engineAndBroker((request) => (request.url.endsWith('/connect/key') ? new Response('boom', { status: 500 }) : null));
  const app = serverLikeApp();
  const logger = recordingLogger();
  const mittr = setupMittr({ app, express, dataDir: tempDataDir(t), logger, host: null, ...engine.context }, { env: DEV_ENV, fetchImpl, credentialRetryMs: 20 });
  t.after(() => mittr.dispose());

  engine.fireReady();
  await mittr.applyModels(MODELS);
  await until(() => engineCalls(fetchImpl).length === 2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(engineCalls(fetchImpl).length, 2);

  await mittr.applyModels(MODELS);
  assert.equal(engineCalls(fetchImpl).length, 3);
  await mittr.dispose();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(engineCalls(fetchImpl).length, 3);
});

test('the same model list again does not rewrite the engine config, and a write that failed is tried again', async (t) => {
  const engine = fakeEngineContext();
  const refresh = engine.context.managedConfig.refresh;
  let failNext = false;
  engine.context.managedConfig.refresh = async () => {
    if (failNext) {
      failNext = false;
      throw new Error('disk full');
    }
    return refresh();
  };
  const { mittr } = await setUp(t, { engine, fetchImpl: engineAndBroker() });

  await mittr.applyModels(MODELS);
  await mittr.applyModels(MODELS);
  assert.equal(engine.refreshes.length, 1);

  failNext = true;
  await assert.rejects(mittr.applyModels([MODELS[0]]), /disk full/);
  await mittr.applyModels([MODELS[0]]);
  assert.equal(engine.refreshes.length, 2);
});

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createManagedConfigRuntime } from '../../../web/server/lib/opencode/managed-config-file.js';
import { setupMittr } from './index.js';
import { mintLocalToken } from './local-token.js';
import { USER_CONFIG_DIR, deferred, fakeEngineContext, fakeEngineFetch, fakeFetch, json, serve, stubAgentBrowser, tempDataDir, until } from './test-helpers.js';
import { CHROME_EXECUTABLE } from './tools/chrome-control.js';

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

// `built` stands for the engine's first config build, which the server makes
// before it first starts the engine.
const shimKeys = new Map();

const setUp = async (t, { host = null, uiAuth, companySignIn, env = DEV_ENV, fetchImpl = fakeFetch(() => json(session)), dataDir = tempDataDir(t), engine = fakeEngineContext(), sharedHistoryExists, built = true, engineConfigDir = USER_CONFIG_DIR, engineDataHome, now, toolDrivers, beforeBuild } = {}) => {
  const app = serverLikeApp();
  const logger = recordingLogger();
  const mintShimKey = () => {
    const key = mintLocalToken();
    shimKeys.set(dataDir, key);
    return key;
  };
  const mittr = setupMittr({ app, express, dataDir, logger, host, ...engine.context, ...(uiAuth ? { uiAuth } : {}) }, { env, fetchImpl, sharedHistoryExists, engineConfigDir, engineDataHome, now, mintShimKey, companySignIn, toolDrivers });
  t.after(() => mittr.dispose());
  engine.contribute = mittr.managedConfig;
  beforeBuild?.(mittr);
  if (built) await mittr.managedConfig();
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

test('a deep-link callback for a cancelled sign-in asks for no event, so a newer wait is left alone', async (t) => {
  const deepLinks = deepLinkHost();
  const { call, logger, fetchImpl } = await setUp(t, { host: { secretStore: sealingStore(), deepLinks } });
  await call('POST', '/api/mittr/auth/start');
  await call('DELETE', '/api/mittr/auth/start');

  const result = await deepLinks.registrations[0].handle({ type: 'auth', raw: 'mittrcraft-dev://auth/callback?code=late' });

  assert.deepEqual(result, {});
  assert.deepEqual(logger.warnings, ['[mittr] a sign-in from the browser arrived for a cancelled attempt and was dropped: No sign-in is in progress']);
  assert.equal(fetchImpl.calls.filter((entry) => entry.url.endsWith('/auth/desktop/exchange')).length, 0);
  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: false });
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

const lazyStore = (available) => {
  const calls = { available: 0 };
  return { calls, ...sealingStore(), available: () => { calls.available += 1; return available; } };
};

test('setting up with a desktop host never asks whether the keychain works; the first status request does', async (t) => {
  const secretStore = lazyStore(true);
  const { call } = await setUp(t, { host: { secretStore, deepLinks: deepLinkHost() } });
  assert.equal(secretStore.calls.available, 0);

  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: false });
  assert.equal(secretStore.calls.available > 0, true);
});

test('a keychain found unusable at the first sign-in request refuses it, and the tokens on disk stay', async (t) => {
  const secretStore = lazyStore(false);
  const { call, dataDir, fetchImpl } = await setUp(t, { host: { secretStore, deepLinks: deepLinkHost() } });
  assert.equal(secretStore.calls.available, 0);

  const refusal = { status: 503, body: { error: "MittrCraft can't find a secure keychain on this computer to keep your sign-in safe." } };
  assert.deepEqual(await call('POST', '/api/mittr/auth/start'), refusal);
  assert.deepEqual(await call('POST', '/api/mittr/auth/callback', { url: 'mittrcraft-dev://auth/callback?code=c1' }), refusal);
  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: false, keychainMissing: true });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(fs.existsSync(path.join(dataDir, 'mittr-accounts')) ? sessionFiles(dataDir).length : 0, 0);
});

test('a signed-in account is not opened while the app starts, only once the engine is ready', async (t) => {
  const dataDir = tempDataDir(t);
  const first = await setUp(t, { dataDir, fetchImpl: platform(), host: { secretStore: sealingStore(), deepLinks: deepLinkHost() } });
  assert.equal((await signIn(first.call)).status, 200);
  await until(() => fs.existsSync(path.join(dataDir, 'mittr-accounts')) && catalogFiles(dataDir).length === 1);
  await first.mittr.dispose();

  const sealing = sealingStore();
  const uses = [];
  const secretStore = {
    available: () => { uses.push('available'); return true; },
    encrypt: (text) => { uses.push('encrypt'); return sealing.encrypt(text); },
    decrypt: (data) => { uses.push('decrypt'); return sealing.decrypt(data); },
  };
  const fetchImpl = platform();
  const { mittr, engine } = await setUp(t, { dataDir, fetchImpl, host: { secretStore, deepLinks: deepLinkHost() } });
  assert.deepEqual(await mittrModelsOf(mittr), ['a1', 'a2']);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(uses, []);
  assert.equal(catalogCalls(fetchImpl).length, 0);

  engine.fireReady();
  await until(() => catalogCalls(fetchImpl).length === 1);
  assert.ok(uses.includes('decrypt'));
});

const writeCachedCatalog = (dataDir, aliases) => {
  const cached = { bundleVersion: 7, subject: null };
  for (const name of ['mcp', 'skills', 'knowledge']) cached[name] = { configured: true, items: [] };
  cached.models = { configured: true, items: aliases.map((alias) => ({ alias, label: alias })) };
  fs.writeFileSync(path.join(dataDir, 'mittr-catalog.json'), JSON.stringify(cached));
};

test('a 1.x single-account user keeps their models and default before the session is carried, and nothing is opened at setup', async (t) => {
  const dataDir = tempDataDir(t);
  const sealing = sealingStore();
  fs.writeFileSync(path.join(dataDir, 'mittr-session'), sealing.encrypt(JSON.stringify(session)));
  writeCachedCatalog(dataDir, ['a1', 'a2']);
  const uses = [];
  const secretStore = {
    available: () => { uses.push('available'); return true; },
    encrypt: (text) => { uses.push('encrypt'); return sealing.encrypt(text); },
    decrypt: (data) => { uses.push('decrypt'); return sealing.decrypt(data); },
  };
  const engine = fakeEngineContext({ userConfigFile: { model: 'mittr/a2' } });
  const { mittr, call } = await setUp(t, { dataDir, engine, fetchImpl: platform(), host: { secretStore, deepLinks: deepLinkHost() } });

  assert.deepEqual(await mittrModelsOf(mittr), ['a1', 'a2']);
  assert.equal(defaultModelOf(engine), 'mittr/a2');
  assert.equal(engine.userConfigWrites.length, 0);
  assert.deepEqual(uses, []);
  assert.equal(fs.existsSync(path.join(dataDir, 'mittr-session')), true);

  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: true, userId: 'u-a', displayName: 'A' });
  assert.equal(fs.existsSync(path.join(dataDir, 'mittr-session')), false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await mittrModelsOf(mittr), ['a1', 'a2']);
  assert.equal(defaultModelOf(engine), 'mittr/a2');
});

test('a 1.x session that cannot be carried does not take the default away while it is only pending', async (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(path.join(dataDir, 'mittr-session'), 'not sealed');
  writeCachedCatalog(dataDir, []);
  const engine = fakeEngineContext({ userConfigFile: { model: 'mittr/a2' } });
  await setUp(t, { dataDir, engine, host: { secretStore: sealingStore(), deepLinks: deepLinkHost() } });
  assert.equal(defaultModelOf(engine), 'mittr/a2');
});

test('a first sync that finds the platform unreachable is tried again at the next ready', async (t) => {
  const dataDir = tempDataDir(t);
  const first = await setUp(t, { dataDir, fetchImpl: platform() });
  assert.equal((await signIn(first.call)).status, 200);
  await until(() => catalogFiles(dataDir).length === 1);
  await first.mittr.dispose();

  let down = true;
  const fetchImpl = platform({ catalog: (request) => (down ? new Response('down', { status: 503 }) : json(CATALOG_A)) });
  const { engine } = await setUp(t, { dataDir, fetchImpl });
  engine.fireReady();
  await until(() => catalogCalls(fetchImpl).length === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  down = false;
  engine.fireReady();
  await until(() => catalogCalls(fetchImpl).length === 2);
  await new Promise((resolve) => setTimeout(resolve, 20));
  engine.fireReady();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(catalogCalls(fetchImpl).length, 2);
});

test('the catalog routes keep a disable in the data dir of this machine, for any account', async (t) => {
  const dataDir = tempDataDir(t);
  const { call } = await setUp(t, { dataDir, fetchImpl: platform() });
  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogFiles(dataDir).length === 1);

  assert.deepEqual(await call('PUT', '/api/mittr/catalog/enablement', { kind: 'skills', name: 'card-analysis', enabled: false }), { status: 200, body: { ok: true } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'mittr-enablement.json'), 'utf8')).skills['card-analysis'].disabled, true);
  const { body } = await call('GET', '/api/mittr/catalog');
  assert.deepEqual(body.models.items.map((item) => item.enabled), [true, true]);
  assert.deepEqual((await call('PUT', '/api/mittr/catalog/enablement', { kind: 'models', name: 'a1' })).status, 400);
});

test('the control route runs an upstream action through the server\'s control service', async (t) => {
  const engine = fakeEngineContext();
  engine.controlAnswer = async () => ({ sessions: [{ id: 's1' }] });
  const { call } = await setUp(t, { engine, host: { secretStore: null, deepLinks: deepLinkHost() } });

  assert.deepEqual(await call('POST', '/api/mittr/control', { action: 'session.list', input: {}, contextDirectory: '/p', contextSessionId: 's1' }), { status: 200, body: { sessions: [{ id: 's1' }] } });
  assert.deepEqual(engine.controlCalls.map(([action, input, directory, { contextSessionId }]) => [action, input, directory, contextSessionId]), [['session.list', {}, '/p', 's1']]);

  const partial = { partial: true, partialAction: 'fork-created', sessionId: 'ses_fork', directory: '/repo' };
  engine.controlAnswer = async () => { throw new engine.context.control.ControlError('dispatch failed', 502, partial); };
  assert.deepEqual(await call('POST', '/api/mittr/control', { action: 'session.list' }), { status: 502, body: { error: 'dispatch failed', ...partial } });
  engine.controlAnswer = async () => ({ sessions: [{ id: 's1' }] });

  engine.scope = 'tunnel';
  assert.equal((await call('POST', '/api/mittr/control', { action: 'session.list', contextSessionId: 's1' })).status, 400);
  assert.equal(engine.controlCalls.length, 2);
});

test('on hosted web the control route names no session', async (t) => {
  const engine = fakeEngineContext();
  const { call } = await setUp(t, { engine, host: null });

  assert.equal((await call('POST', '/api/mittr/control', { action: 'session.list', contextSessionId: 's1' })).status, 400);
  assert.equal((await call('POST', '/api/mittr/control', { action: 'session.list' })).status, 200);
  assert.equal(engine.controlCalls.length, 1);
});

test('startup gives one catalog request', async (t) => {
  const dataDir = tempDataDir(t);
  const first = await setUp(t, { dataDir, fetchImpl: platform() });
  assert.equal((await signIn(first.call)).status, 200);
  await until(() => catalogFiles(dataDir).length === 1);
  await first.mittr.dispose();

  const fetchImpl = platform();
  const { engine } = await setUp(t, { dataDir, fetchImpl });
  engine.fireReady();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(catalogCalls(fetchImpl).length, 1);
});

test('a sign-in gives one catalog request', async (t) => {
  const fetchImpl = platform();
  const { call } = await setUp(t, { fetchImpl });
  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(catalogCalls(fetchImpl).length, 1);

  assert.equal((await signIn(call)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(catalogCalls(fetchImpl).length, 2);
});

test('a switch gives one catalog request', async (t) => {
  const fetchImpl = platform({ sessions: [session, sessionB] });
  const { call } = await setUp(t, { fetchImpl });
  assert.equal((await signIn(call)).status, 200);
  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const before = catalogCalls(fetchImpl).length;

  assert.equal((await call('POST', '/api/mittr/auth/accounts/activate', { userId: 'u-a' })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(catalogCalls(fetchImpl).length, before + 1);
});

test('each sync route call gives one catalog request when called one after another', async (t) => {
  const fetchImpl = platform();
  const { call } = await setUp(t, { fetchImpl });
  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));

  for (let n = 2; n <= 4; n += 1) {
    assert.equal((await call('POST', '/api/mittr/catalog/sync')).status, 200);
    assert.equal(catalogCalls(fetchImpl).length, n);
  }
});

test('only the first ready starts the catalog sync', async (t) => {
  const dataDir = tempDataDir(t);
  const first = await setUp(t, { dataDir, fetchImpl: platform() });
  assert.equal((await signIn(first.call)).status, 200);
  await until(() => catalogFiles(dataDir).length === 1);
  await first.mittr.dispose();

  const fetchImpl = platform();
  const { engine } = await setUp(t, { dataDir, fetchImpl });
  engine.fireReady();
  await until(() => catalogCalls(fetchImpl).length === 1);
  engine.fireReady();
  engine.fireReady();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(catalogCalls(fetchImpl).length, 1);
});

const engineThatRestartsOntoTheAccount = () => {
  const dataHomeOf = (home) => `/engine-data/${home ?? 'shared'}`;
  const engine = fakeEngineContext();
  const restartOnto = (mittr) => {
    engine.onRestart = () => {
      engine.launchedDataHome = dataHomeOf(mittr.engineHome());
      engine.fireReady();
    };
  };
  return { engine, dataHomeOf, restartOnto };
};

test('a first sign-in on a fresh install gives one catalog request, and the engine still gets its key', async (t) => {
  const fetchImpl = platform();
  const { engine, dataHomeOf, restartOnto } = engineThatRestartsOntoTheAccount();
  const { mittr, call, logger } = await setUp(t, { engine, fetchImpl, engineDataHome: dataHomeOf });
  restartOnto(mittr);
  engine.launchedDataHome = dataHomeOf(mittr.engineHome());
  engine.fireReady();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(catalogCalls(fetchImpl).length, 0);

  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 1);
  await until(() => logger.lines.includes('[mittr] the engine has its Mittr key for this run'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(catalogCalls(fetchImpl).length, 1);
  assert.equal(engine.launchedDataHome, dataHomeOf(mittr.engineHome()));
  assert.deepEqual(await mittrModelsOf(mittr), ['a1', 'a2']);
});

test('a sign-in before the engine\'s first ready gives one catalog request', async (t) => {
  const fetchImpl = platform();
  const { engine, dataHomeOf, restartOnto } = engineThatRestartsOntoTheAccount();
  const { mittr, call } = await setUp(t, { engine, fetchImpl, engineDataHome: dataHomeOf });
  restartOnto(mittr);

  assert.equal((await signIn(call)).status, 200);
  engine.launchedDataHome = dataHomeOf(mittr.engineHome());
  engine.fireReady();
  await until(() => catalogCalls(fetchImpl).length === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(catalogCalls(fetchImpl).length, 1);
});

test('on a fresh install, a first sign-in whose catalog read fails is read once more at the next ready', async (t) => {
  let down = true;
  const fetchImpl = platform({ catalog: () => (down ? new Response('down', { status: 503 }) : json(CATALOG_A)) });
  const { engine, dataHomeOf, restartOnto } = engineThatRestartsOntoTheAccount();
  const { mittr, call } = await setUp(t, { engine, fetchImpl, engineDataHome: dataHomeOf });
  restartOnto(mittr);
  engine.launchedDataHome = dataHomeOf(mittr.engineHome());
  engine.fireReady();

  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(catalogCalls(fetchImpl).length, 1);

  down = false;
  engine.fireReady();
  await until(() => catalogCalls(fetchImpl).length === 2);
  await until(async () => (await mittrModelsOf(mittr)).length === 2);
  engine.fireReady();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(catalogCalls(fetchImpl).length, 2);
});

test('a startup sync never takes another account\'s sync as its own', async (t) => {
  const fetchImpl = platform({ sessions: [session, sessionB] });
  const { engine, dataHomeOf } = engineThatRestartsOntoTheAccount();
  const { mittr, call } = await setUp(t, { engine, fetchImpl, engineDataHome: dataHomeOf });
  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 1);
  await new Promise((resolve) => setTimeout(resolve, 50));

  engine.launchedDataHome = dataHomeOf(mittr.engineHome());
  const held = deferred();
  engine.onRestart = () => {
    engine.launchedDataHome = dataHomeOf(mittr.engineHome());
    engine.fireReady();
    return held.promise;
  };
  const added = signIn(call);
  await until(() => catalogCalls(fetchImpl).length === 2);
  assert.deepEqual(catalogCalls(fetchImpl).map((request) => request.headers.authorization), ['Bearer at-1', 'Bearer at-b']);
  held.resolve();
  assert.equal((await added).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(catalogCalls(fetchImpl).slice(1).every((request) => request.headers.authorization === 'Bearer at-b'));
});

test('an engine that becomes ready twice while a sign-in reads the catalog adds no read for that account', async (t) => {
  const answered = deferred();
  const fetchImpl = platform({ catalog: async () => { await answered.promise; return json(CATALOG_A); } });
  const { engine, dataHomeOf } = engineThatRestartsOntoTheAccount();
  const { mittr, call } = await setUp(t, { engine, fetchImpl, engineDataHome: dataHomeOf });
  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 1);

  engine.launchedDataHome = dataHomeOf(mittr.engineHome());
  engine.fireReady();
  engine.fireReady();
  await new Promise((resolve) => setTimeout(resolve, 20));
  answered.resolve();
  await until(async () => (await mittrModelsOf(mittr)).length === 2);
  engine.fireReady();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(catalogCalls(fetchImpl).length, 1);
});

test('after a first sign-in on a fresh install, signing in again and adding another account each still read the catalog', async (t) => {
  const fetchImpl = platform({ sessions: [session, session, sessionB] });
  const { engine, dataHomeOf, restartOnto } = engineThatRestartsOntoTheAccount();
  const { mittr, call } = await setUp(t, { engine, fetchImpl, engineDataHome: dataHomeOf });
  restartOnto(mittr);
  engine.launchedDataHome = dataHomeOf(mittr.engineHome());
  engine.fireReady();

  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 3);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(catalogCalls(fetchImpl).length, 3);
  assert.deepEqual(catalogCalls(fetchImpl).map((request) => request.headers.authorization), ['Bearer at-1', 'Bearer at-1', 'Bearer at-b']);
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

const identityDirOf = (dataDir) => path.join(dataDir, 'engine-plugins', 'mittrcraft-identity');
const toolsDirOf = (dataDir) => path.join(dataDir, 'engine-plugins', 'mittrcraft-tools');

test('setup hands the server plugin an engine env, a config fragment and a bounded dispose', async (t) => {
  const { mittr, engine, dataDir } = await setUp(t);
  const { MITTRCRAFT_TOOLS_TOKEN: token, ...env } = await mittr.engineEnv();
  assert.deepEqual(env, { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', MITTRCRAFT_TOOLS_URL: 'http://127.0.0.1:4100/mittr-tools/v1/call' });
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await mittr.managedConfig(), { plugins: [identityDirOf(dataDir), toolsDirOf(dataDir)], share: 'disabled', experimental: { policies: LOCKED } });
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
const shimKey = (dataDir) => shimKeys.get(dataDir);
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
  assert.equal(fs.existsSync(path.join(dataDir, 'mittr-shim-token')), false);

  const signedOut = await askShim(call, key);
  assert.equal(signedOut.status, 401);
  assert.deepEqual(await signedOut.json(), { error: { type: 'mittr_unavailable', code: 'not_signed_in', message: 'Not signed in to Mittr. Sign in to continue.' } });

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
  assert.deepEqual(await (await askShim(second.call, newKey)).json(), { error: { type: 'mittr_unavailable', code: 'not_signed_in', message: 'Not signed in to Mittr. Sign in to continue.' } });
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
  assert.deepEqual(await response.json(), { error: { type: 'mittr_unavailable', code: 'not_signed_in', message: 'Not signed in to Mittr. Sign in to continue.' } });
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

const SUBSTITUTED_FRAME = `data: ${JSON.stringify({
  choices: [{ delta: { content: 'hi' } }],
  answered_by: { substituted: true, requestedLabel: 'Writer', answeredLabel: 'Backup', reason: 'quota' },
})}\n\ndata: [DONE]\n\n`;

test('an answer from a backup is listed for its session, and a sign-out clears the list', async (t) => {
  const fetchImpl = fakeFetch((request) => (request.url.endsWith('/chat/completions')
    ? new Response(SUBSTITUTED_FRAME, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    : json(session)));
  const { call, dataDir } = await setUp(t, { fetchImpl });
  assert.equal((await signIn(call)).status, 200);

  const response = await fetch(`${call.base}/mittr-shim/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${shimKey(dataDir)}`, 'x-opencode-session-id': 'ses_1' },
    body: JSON.stringify({ model: 'writer', stream: true, messages: [] }),
  });
  await response.text();

  const listed = await call('GET', '/api/mittr/answered-by?sessionId=ses_1');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.answers.map(({ model, answeredLabel, reason }) => ({ model, answeredLabel, reason })), [{ model: 'writer', answeredLabel: 'Backup', reason: 'quota' }]);
  assert.deepEqual((await call('GET', '/api/mittr/answered-by?sessionId=ses_2')).body.answers, []);

  assert.equal((await call('DELETE', '/api/mittr/auth/session')).status, 200);
  assert.deepEqual((await call('GET', '/api/mittr/answered-by?sessionId=ses_1')).body.answers, []);
});

const auditCalls = (fetchImpl) => fetchImpl.calls.filter((request) => request.url.endsWith('/desktop/audit'));

test('the audit routes send a finished session with the active account\'s token and the remote from the server\'s git', async (t) => {
  const fetchImpl = platform();
  const { call, engine } = await setUp(t, { fetchImpl });
  engine.remotes['/work/app'] = 'https://person:s3cret-token@github.com/techflowasia/mittr-craft.git';
  assert.equal((await signIn(call)).status, 200);

  const post = (route, body) => fetch(`${call.base}/api/mittr/audit/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('prompt', { sessionId: 's1', text: 'add a button' })).status, 204);
  assert.equal((await post('tool', { sessionId: 's1', name: 'edit' })).status, 204);
  assert.equal((await post('finish', { sessionId: 's1', directory: '/work/app', outcome: 'completed' })).status, 204);

  const [audit] = auditCalls(fetchImpl);
  assert.equal(audit.url, 'https://api-dev.mittr.asia/desktop/audit');
  assert.equal(audit.headers.authorization, 'Bearer at-1');
  assert.equal(audit.body.repository, 'techflowasia/mittr-craft');
  assert.deepEqual(audit.body.prompts.map(({ text }) => text), ['add a button']);
  assert.deepEqual(audit.body.actions, [{ tool: 'edit', count: 1 }]);
  assert.equal(JSON.stringify(audit.body).includes('s3cret'), false);
});

test('a record started under one account is never sent as another', async (t) => {
  const fetchImpl = platform({ sessions: [session, sessionB] });
  const { call } = await setUp(t, { fetchImpl });
  assert.equal((await signIn(call)).status, 200);

  const post = (route, body) => fetch(`${call.base}/api/mittr/audit/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post('prompt', { sessionId: 's1', text: 'typed as the first account' });
  await post('tool', { sessionId: 's1', name: 'edit' });

  assert.equal((await signIn(call)).status, 200);
  assert.equal((await post('prompt', { sessionId: 's1', text: 'a late prompt' })).status, 204);
  assert.equal((await post('finish', { sessionId: 's1', directory: '/work/app', outcome: 'completed' })).status, 204);
  assert.equal(auditCalls(fetchImpl).length, 0);

  await post('prompt', { sessionId: 's2', text: 'typed as the second account' });
  assert.equal((await post('finish', { sessionId: 's2', directory: '/work/app', outcome: 'completed' })).status, 204);
  const [audit] = auditCalls(fetchImpl);
  assert.equal(audit.headers.authorization, 'Bearer at-b');
  assert.deepEqual(audit.body.prompts.map(({ text }) => text), ['typed as the second account']);
  assert.equal(JSON.stringify(audit.body).includes('first account'), false);
});

test('a switch back to an earlier account drops the records open as well', async (t) => {
  const fetchImpl = platform({ sessions: [session, sessionB] });
  const { call } = await setUp(t, { fetchImpl });
  assert.equal((await signIn(call)).status, 200);
  assert.equal((await signIn(call)).status, 200);

  const post = (route, body) => fetch(`${call.base}/api/mittr/audit/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post('prompt', { sessionId: 's1', text: 'typed as the second account' });
  assert.equal((await call('POST', '/api/mittr/auth/accounts/activate', { userId: 'u-a' })).status, 200);
  assert.equal((await post('finish', { sessionId: 's1', directory: '/work/app', outcome: 'completed' })).status, 204);
  assert.equal(auditCalls(fetchImpl).length, 0);
});

test('an audit call never opens or decrypts a 1.x session that is still waiting to be carried', async (t) => {
  const dataDir = tempDataDir(t);
  const sealing = sealingStore();
  fs.writeFileSync(path.join(dataDir, 'mittr-session'), sealing.encrypt(JSON.stringify(session)));
  const uses = [];
  const secretStore = {
    available: () => { uses.push('available'); return true; },
    encrypt: (text) => { uses.push('encrypt'); return sealing.encrypt(text); },
    decrypt: (data) => { uses.push('decrypt'); return sealing.decrypt(data); },
  };
  const fetchImpl = platform();
  const { call } = await setUp(t, { dataDir, fetchImpl, host: { secretStore, deepLinks: deepLinkHost() } });

  const post = (route, body) => fetch(`${call.base}/api/mittr/audit/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const [route, body] of [
    ['prompt', { sessionId: 's1', text: 'hello' }],
    ['tool', { sessionId: 's1', name: 'edit' }],
    ['turn', { sessionId: 's1', tokens: 3 }],
    ['finish', { sessionId: 's1', directory: '/work/app', outcome: 'completed' }],
  ]) assert.equal((await post(route, body)).status, 204, route);

  assert.deepEqual(uses, []);
  assert.equal(fs.existsSync(path.join(dataDir, 'mittr-session')), true);
  assert.equal(auditCalls(fetchImpl).length, 0);
});

test('signed out, a finished session sends nothing and still answers 204', async (t) => {
  const fetchImpl = platform();
  const { call } = await setUp(t, { fetchImpl });
  assert.equal((await signIn(call)).status, 200);

  const post = (route, body) => fetch(`${call.base}/api/mittr/audit/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post('prompt', { sessionId: 's1', text: 'typed while signed in' });
  assert.equal((await call('DELETE', '/api/mittr/auth/session')).status, 200);
  assert.equal((await post('finish', { sessionId: 's1', directory: '/work/app', outcome: 'completed' })).status, 204);
  assert.equal(auditCalls(fetchImpl).length, 0);
});

test('a retry while the engine is already on the account\'s home answers at once and leaves a streaming answer alone', async (t) => {
  const held = heldStream();
  const fetchImpl = fakeFetch((request) => (request.url.endsWith('/chat/completions') ? held.respond(request.signal) : json(session)));
  const engine = fakeEngineContext();
  const { call, dataDir } = await setUp(t, { fetchImpl, engine });
  assert.equal((await signIn(call)).status, 200);
  const restarts = engine.restarts.length;

  const response = await askShim(call, shimKey(dataDir), { model: 'gpt-a', stream: true, messages: [] });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  await reader.read();

  const retried = await call('POST', '/api/mittr/auth/accounts/retry-switch');
  assert.equal(retried.status, 200);
  assert.equal(retried.body.signedIn, true);
  assert.equal(retried.body.engineRestarted, undefined);
  assert.equal(engine.restarts.length, restarts);
  assert.equal(await Promise.race([held.aborted.then(() => 'aborted'), new Promise((resolve) => { setTimeout(() => resolve('still streaming'), 200); })]), 'still streaming');
  await reader.cancel();
});

const MODELS = [{ alias: 'a1', label: 'Writer' }, { alias: 'a2', label: '' }];
const engineCalls = (fetchImpl) => fetchImpl.calls.filter((call) => call.url.includes('/api/integration/'));
const engineAndBroker = (answer) => fakeEngineFetch({ answer, other: () => json(session) });

test('the lock is in the config from the first build, before any model or port', async (t) => {
  const engine = fakeEngineContext({ port: null });
  const { mittr, dataDir } = await setUp(t, { engine });
  assert.deepEqual(await mittr.managedConfig(), { plugins: [identityDirOf(dataDir), toolsDirOf(dataDir)], share: 'disabled', experimental: { policies: LOCKED } });
});

test('the identity plugin is on disk before the config names it', async (t) => {
  const { mittr, dataDir } = await setUp(t, { built: false });
  const config = await mittr.managedConfig();
  assert.deepEqual(config.plugins, [identityDirOf(dataDir), toolsDirOf(dataDir)]);
  const source = fs.readFileSync(path.join(identityDirOf(dataDir), 'index.js'), 'utf8');
  assert.ok(source.includes("'mittrcraft.identity'") || source.includes('"mittrcraft.identity"'), source.slice(0, 200));
});

test('a plugin that cannot be rewritten keeps the one already on disk in the config', { skip: process.platform === 'win32' }, async (t) => {
  const { mittr, dataDir, logger } = await setUp(t);
  const dir = identityDirOf(dataDir);
  fs.writeFileSync(path.join(dir, 'index.js'), 'export default { id: "older", setup: async () => {} }\n');
  fs.chmodSync(dir, 0o500);
  let config;
  try {
    config = await mittr.managedConfig();
  } finally {
    fs.chmodSync(dir, 0o700);
  }

  assert.deepEqual(config.plugins, [dir, toolsDirOf(dataDir)]);
  assert.deepEqual(config.experimental.policies, LOCKED);
  assert.ok(logger.warnings.some((line) => line.startsWith('[mittr] could not rewrite the identity plugin; keeping the one already written')), logger.warnings.join('\n'));
});

test('an identity plugin that cannot be written leaves the lock and the models in the config', async (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(path.join(dataDir, 'engine-plugins'), 'not a folder');
  const engine = fakeEngineContext({ port: 4100 });
  const { mittr, logger } = await setUp(t, { dataDir, engine, fetchImpl: engineAndBroker() });
  await mittr.applyModels(MODELS);

  const config = await mittr.managedConfig();
  assert.equal(config.plugins, undefined);
  assert.deepEqual(config.experimental.policies, LOCKED);
  assert.deepEqual(Object.keys(config.providers.mittr.models), ['a1', 'a2']);
  assert.ok(logger.warnings.some((line) => line.startsWith('[mittr] could not write the identity plugin')), logger.warnings.join('\n'));
});

test('the stored switch ON still denies the hosted opencode provider', async (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(path.join(dataDir, 'mittr-settings.json'), JSON.stringify({ showOtherProviders: true }));
  const { mittr } = await setUp(t, { dataDir });
  assert.deepEqual(await mittr.managedConfig(), {
    plugins: [identityDirOf(dataDir), toolsDirOf(dataDir)],
    share: 'disabled',
    experimental: { policies: [{ action: 'provider.use', resource: 'opencode', effect: 'deny' }] },
  });
});

test('engine session sharing is off with the switch off and on, and stays off across a flip', async (t) => {
  const engine = fakeEngineContext();
  const { mittr, call } = await setUp(t, { engine });
  assert.equal((await mittr.managedConfig()).share, 'disabled');
  assert.equal((await call('PUT', '/api/mittr/provider-lock', { showOtherProviders: true })).status, 200);
  assert.deepEqual(engine.rendered.at(-1).experimental.policies, OTHERS_SHOWN);
  assert.equal(engine.rendered.at(-1).share, 'disabled');
  assert.equal((await call('PUT', '/api/mittr/provider-lock', { showOtherProviders: false })).status, 200);
  assert.deepEqual(engine.rendered.at(-1).experimental.policies, LOCKED);
  assert.equal(engine.rendered.at(-1).share, 'disabled');
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
const platform = ({ sessions = [session], catalogs = { 'at-1': CATALOG_A, 'at-b': CATALOG_B }, catalog = null, answer } = {}) => {
  let exchanges = 0;
  return fakeEngineFetch({
    answer,
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
  assert.deepEqual(await mittrModelsOf(mittr), ['a1', 'a2']);
  // The engine has not started yet: its first config build reads these.
  assert.equal(engine.refreshes.length, 0);
  assert.equal(catalogCalls(fetchImpl).length, 0);
  engine.fireReady();
  await until(() => catalogCalls(fetchImpl).length === 1);

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
  assert.deepEqual(await unavailable.json(), { error: { type: 'mittr_unavailable', code: 'model_list_unavailable', message: 'The Mittr model list is not available' } });
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

const defaultModelOf = (engine) => engine.userConfigFile.model;

test('a signed-in fresh install starts on the first Mittr agent, once the engine config carries the agents', async (t) => {
  const fetchImpl = platform();
  const { call, engine } = await setUp(t, { fetchImpl });
  assert.deepEqual(engine.userConfigWrites, []);

  assert.equal((await signIn(call)).status, 200);
  await until(() => defaultModelOf(engine) === 'mittr/a1');
  assert.deepEqual(engine.userConfigWrites.map(({ config }) => config), [{ model: 'mittr/a1' }]);
  // The refresh just before the write put the agents in the engine config.
  const { afterRefreshes } = engine.userConfigWrites[0];
  assert.deepEqual(Object.keys(engine.rendered[afterRefreshes - 1].providers.mittr.models), ['a1', 'a2']);

  assert.equal((await call('POST', '/api/mittr/catalog/sync')).status, 200);
  assert.equal(engine.userConfigWrites.length, 1);
});

test('a default the person chose is kept while it is offered, and one on another provider always', async (t) => {
  for (const model of ['mittr/a2', 'openai/gpt-x']) {
    const { call, engine } = await setUp(t, { fetchImpl: platform() });
    assert.equal((await signIn(call)).status, 200);
    await until(() => defaultModelOf(engine) === 'mittr/a1');
    engine.userConfigFile.model = model;
    const writes = engine.userConfigWrites.length;

    assert.equal((await call('POST', '/api/mittr/catalog/sync')).status, 200);
    assert.equal((await call('POST', '/api/mittr/auth/accounts/activate', { userId: 'u-a' })).status, 200);
    assert.equal(engine.userConfigWrites.length, writes, model);
    assert.equal(defaultModelOf(engine), model);
  }
});

test('signing out takes the Mittr default out, so no default is claimed without Mittr models', async (t) => {
  const { call, engine } = await setUp(t, { fetchImpl: platform() });
  assert.equal((await signIn(call)).status, 200);
  await until(() => defaultModelOf(engine) === 'mittr/a1');

  assert.equal((await call('DELETE', '/api/mittr/auth/session')).status, 200);
  assert.equal(Object.hasOwn(engine.userConfigFile, 'model'), false);
});

test('an account whose catalog has not arrived keeps the default until it does, and a cached switch moves it at once', async (t) => {
  let held = null;
  const fetchImpl = platform({
    sessions: [session, sessionB],
    catalog: (request) => {
      const answer = json({ 'at-1': CATALOG_A, 'at-b': CATALOG_B }[request.headers.authorization.slice('Bearer '.length)]);
      return held ? held.promise.then(() => answer) : answer;
    },
  });
  const { call, engine, mittr } = await setUp(t, { fetchImpl });
  assert.equal((await signIn(call)).status, 200);
  await until(() => defaultModelOf(engine) === 'mittr/a1');
  engine.userConfigFile.model = 'mittr/a2';

  held = deferred();
  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 2);
  assert.deepEqual(await mittrModelsOf(mittr), []);
  assert.equal(defaultModelOf(engine), 'mittr/a2');

  const release = held;
  held = null;
  release.resolve();
  await until(() => defaultModelOf(engine) === 'mittr/b1');

  assert.equal((await call('POST', '/api/mittr/auth/accounts/activate', { userId: 'u-a' })).status, 200);
  assert.equal(defaultModelOf(engine), 'mittr/a1');
});

test('a start with nobody signed in takes a Mittr default left behind out', async (t) => {
  const engine = fakeEngineContext({ userConfigFile: { model: 'mittr/a1', theme: 'dark' } });
  await setUp(t, { engine });
  assert.deepEqual(engine.userConfigFile, { theme: 'dark' });
});

test('the default is left alone when the server\'s user config is not the file the engine reads', async (t) => {
  const { call, engine, mittr, logger } = await setUp(t, { fetchImpl: platform(), engineConfigDir: '/elsewhere/opencode' });
  assert.equal((await signIn(call)).status, 200);
  await until(async () => (await mittrModelsOf(mittr)).length === 2);
  assert.equal((await call('POST', '/api/mittr/catalog/sync')).status, 200);
  assert.deepEqual(engine.userConfigWrites, []);
  assert.deepEqual(logger.warnings.filter((line) => line.includes('default model')), [
    `[mittr] the engine reads its config from /elsewhere/opencode, not ${USER_CONFIG_DIR}; the default model is left alone`,
  ]);
});

test('a user config that cannot be read is logged, and the models still apply', async (t) => {
  const engine = fakeEngineContext({ userConfigFile: { model: 'mittr/a1' } });
  engine.userConfigError = new Error('Failed to read OpenCode configuration');
  const { call, mittr, logger } = await setUp(t, { engine, fetchImpl: platform() });
  assert.equal((await signIn(call)).status, 200);
  await until(async () => (await mittrModelsOf(mittr)).length === 2);
  assert.equal((await call('POST', '/api/mittr/catalog/sync')).status, 200);
  assert.ok(logger.warnings.some((line) => line === '[mittr] could not set the default model: Failed to read OpenCode configuration'), logger.warnings.join('\n'));
  assert.equal(logger.warnings.some((line) => line.includes('could not apply the Mittr models')), false);
  assert.deepEqual(engine.userConfigWrites, []);
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

// The server's order: it renders every plugin's config, then writes the file,
// and the write is what fails.
const failingWrites = (engine) => {
  const refresh = engine.context.managedConfig.refresh;
  const failures = { next: 0 };
  engine.context.managedConfig.refresh = async () => {
    if (failures.next === 0) return refresh();
    failures.next -= 1;
    engine.refreshes.push(Date.now());
    await engine.contribute();
    throw new Error('disk full');
  };
  return failures;
};
const renderedAliasesOf = (engine) => Object.keys(engine.rendered.at(-1)?.providers?.mittr?.models ?? {});

test('the same model list again does not rewrite the engine config, and a write that failed is tried again', async (t) => {
  const engine = fakeEngineContext();
  const failures = failingWrites(engine);
  const { mittr } = await setUp(t, { engine, fetchImpl: engineAndBroker() });

  await mittr.applyModels(MODELS);
  await mittr.applyModels(MODELS);
  assert.equal(engine.refreshes.length, 1);

  failures.next = 1;
  await assert.rejects(mittr.applyModels([MODELS[0]]), /disk full/);
  await mittr.applyModels([MODELS[0]]);
  assert.equal(engine.refreshes.length, 3);
  assert.deepEqual(renderedAliasesOf(engine), ['a1']);
});

test('a list whose config was rendered but not written is written by the next apply of the same list', async (t) => {
  const engine = fakeEngineContext();
  const failures = failingWrites(engine);
  const { mittr, logger } = await setUp(t, { engine, fetchImpl: engineAndBroker() });

  failures.next = 1;
  await assert.rejects(mittr.applyModels(MODELS), /disk full/);
  assert.equal(engine.rendered.length, 0);

  await mittr.applyModels(MODELS);
  assert.equal(engine.refreshes.length, 2);
  assert.deepEqual(renderedAliasesOf(engine), ['a1', 'a2']);
  await mittr.applyModels(MODELS);
  assert.equal(engine.refreshes.length, 2);
  assert.deepEqual(logger.warnings, []);
});

test('overlapping applies leave the engine config on the last list, and a later apply of an older list still writes it', async (t) => {
  const engine = fakeEngineContext();
  const { mittr } = await setUp(t, { engine, fetchImpl: engineAndBroker() });
  const renderedAliases = () => renderedAliasesOf(engine);

  const gate = deferred();
  engine.refreshGate = gate.promise;
  const first = mittr.applyModels(MODELS);
  const second = mittr.applyModels([]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(engine.refreshes.length, 1);
  engine.refreshGate = null;
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(engine.refreshes.length, 2);
  assert.deepEqual(renderedAliases(), []);

  await mittr.applyModels(MODELS);
  assert.equal(engine.refreshes.length, 3);
  assert.deepEqual(renderedAliases(), ['a1', 'a2']);
});

test('an apply before the engine config is first built triggers no refresh, and the first build carries it', async (t) => {
  const engine = fakeEngineContext();
  const { mittr } = await setUp(t, { engine, fetchImpl: engineAndBroker(), built: false });
  await mittr.applyModels(MODELS);
  assert.equal(engine.refreshes.length, 0);

  assert.deepEqual(Object.keys((await mittr.managedConfig()).providers.mittr.models), ['a1', 'a2']);
  // The build's own write is not reported back, so the first apply after it
  // writes once more; from then on the same list is not written again.
  await mittr.applyModels(MODELS);
  assert.equal(engine.refreshes.length, 1);
  await mittr.applyModels(MODELS);
  assert.equal(engine.refreshes.length, 1);
  await mittr.applyModels([MODELS[0]]);
  assert.equal(engine.refreshes.length, 2);
});

const OTHERS_SHOWN = [{ action: 'provider.use', resource: 'opencode', effect: 'deny' }];

test('the provider switch rewrites the engine config with the new lock and keeps the models', async (t) => {
  const engine = fakeEngineContext();
  const { mittr, call, dataDir } = await setUp(t, { engine, fetchImpl: engineAndBroker() });
  await mittr.applyModels(MODELS);
  assert.equal(engine.refreshes.length, 1);

  assert.deepEqual(await call('PUT', '/api/mittr/provider-lock', { showOtherProviders: true }), { status: 200, body: { showOtherProviders: true } });
  assert.equal(engine.refreshes.length, 2);
  assert.deepEqual(engine.rendered.at(-1).experimental.policies, OTHERS_SHOWN);
  assert.deepEqual(renderedAliasesOf(engine), ['a1', 'a2']);
  assert.deepEqual(engine.broadcasts, [{ type: 'mittr.provider-lock.changed', payload: { showOtherProviders: true } }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'mittr-settings.json'), 'utf8')), { showOtherProviders: true });
  assert.deepEqual(engine.restarts, [], 'the engine reloads its config without a restart');

  // The switch's write carried the same list, so the list is not written again.
  await mittr.applyModels(MODELS);
  assert.equal(engine.refreshes.length, 2);

  assert.equal((await call('PUT', '/api/mittr/provider-lock', { showOtherProviders: false })).status, 200);
  assert.deepEqual(engine.rendered.at(-1).experimental.policies, LOCKED);
  assert.deepEqual((await call('GET', '/api/mittr/provider-lock')).body, { showOtherProviders: false });
});

test('a switch change waits for a model list being written, so neither write is lost', async (t) => {
  const engine = fakeEngineContext();
  const { mittr, call } = await setUp(t, { engine, fetchImpl: engineAndBroker() });

  const gate = deferred();
  engine.refreshGate = gate.promise;
  const applied = mittr.applyModels(MODELS);
  const switched = call('PUT', '/api/mittr/provider-lock', { showOtherProviders: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(engine.refreshes.length, 1);
  engine.refreshGate = null;
  gate.resolve();
  await applied;
  assert.equal((await switched).status, 200);

  assert.equal(engine.refreshes.length, 2);
  assert.deepEqual(engine.rendered.at(-1).experimental.policies, OTHERS_SHOWN);
  assert.deepEqual(renderedAliasesOf(engine), ['a1', 'a2']);
});

test('a switch change before the engine config is first built writes nothing, and the first build carries it', async (t) => {
  const engine = fakeEngineContext();
  const { mittr, call } = await setUp(t, { engine, built: false });
  assert.equal((await call('PUT', '/api/mittr/provider-lock', { showOtherProviders: true })).status, 200);
  assert.equal(engine.refreshes.length, 0);
  assert.deepEqual((await mittr.managedConfig()).experimental.policies, OTHERS_SHOWN);
});

const QUOTA_WEEK = {
  weekStart: '2026-10-12T17:00:00.000Z',
  resetsAt: '2026-10-19T17:00:00.000Z',
  lines: [
    { modelKey: 'a1', kind: 'chat', label: 'Writer', used: 30, limit: 50, source: 'group' },
    { modelKey: 'm:9b17db7ab3d1', kind: 'chat', label: '', labelKey: 'quota.role.decision', used: 1, limit: 10, source: 'default' },
  ],
};
const isQuotaCall = (request) => request.url.endsWith('/api/quota/me');
const quotaPlatform = (week = QUOTA_WEEK) => fakeEngineFetch({
  other: (request) => {
    if (isQuotaCall(request)) return json(week);
    if (isCatalogCall(request)) return json(CATALOG_A);
    return json(session);
  },
});

test('Mittr is a usage provider while the plugin runs, and gone after dispose', async (t) => {
  const engine = fakeEngineContext();
  const { mittr } = await setUp(t, { engine, fetchImpl: quotaPlatform() });
  assert.deepEqual(engine.quotaProviders.map((entry) => [entry.providerId, entry.providerName]), [['mittr', 'Mittr']]);
  assert.deepEqual(engine.quotaProviderOptions, [{ exclusive: true }]);
  await mittr.dispose();
  assert.deepEqual(engine.quotaProviders, []);
});

test('the usage provider is configured only while someone is signed in', async (t) => {
  const engine = fakeEngineContext();
  const { mittr, call } = await setUp(t, { engine, fetchImpl: quotaPlatform() });
  const [provider] = engine.quotaProviders;
  assert.equal(provider.isConfigured({}), false);
  assert.equal((await signIn(call)).status, 200);
  assert.equal(provider.isConfigured({}), true);
  await until(async () => (await mittrModelsOf(mittr)).length === 2);
  const result = await provider.fetchQuota();
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.usage.models), ['Writer']);
  assert.equal(result.usage.models.Writer.windows.weekly.valueLabel, '20 of 50 left');
  assert.equal(result.usage.models.Writer.windows.weekly.resetAt, Date.parse(QUOTA_WEEK.resetsAt));
});

test('this week\'s quota is read with the account token, and a signed-out read is refused', async (t) => {
  const fetchImpl = quotaPlatform();
  const { call } = await setUp(t, { fetchImpl });
  const signedOut = await call('GET', '/api/mittr/quota/me');
  assert.equal(signedOut.status, 401);
  assert.deepEqual(signedOut.body, { error: 'Could not read this week’s quota', reasonCode: 'not_signed_in' });
  assert.equal(fetchImpl.calls.filter(isQuotaCall).length, 0);

  assert.equal((await signIn(call)).status, 200);
  const signedInRead = await call('GET', '/api/mittr/quota/me');
  assert.equal(signedInRead.status, 200);
  assert.deepEqual(signedInRead.body, QUOTA_WEEK);
  const [request] = fetchImpl.calls.filter(isQuotaCall);
  assert.equal(request.url, 'https://api-dev.mittr.asia/api/quota/me');
  assert.equal(request.headers.Authorization, 'Bearer at-1');
});

const isWorkCall = (request) => request.url.endsWith('/desktop/work');
const WORK_ITEMS = [{ id: 'j-1', title: 'Fix the audit', project: 'MRKB', phase: null, state: 'To Do', priority: null, due: null, estimate: null, url: 'https://jira.example/browse/MRKB-2122', updatedAt: '2026-10-19T08:00:00.000Z', source: 'jira', key: 'MRKB-2122' }];

test('My work answers not configured when signed out, then reads the signed-in account\'s items with its token', async (t) => {
  const fetchImpl = fakeEngineFetch({
    other: (request) => {
      if (isWorkCall(request)) return json({ items: WORK_ITEMS });
      if (isCatalogCall(request)) return json(CATALOG_A);
      return json(session);
    },
  });
  const { call } = await setUp(t, { fetchImpl });
  assert.deepEqual(await call('GET', '/api/mittr/work'), { status: 200, body: { configured: false, items: [], userId: null } });
  assert.equal(fetchImpl.calls.filter(isWorkCall).length, 0);

  assert.equal((await signIn(call)).status, 200);
  assert.deepEqual(await call('GET', '/api/mittr/work'), { status: 200, body: { configured: true, items: WORK_ITEMS, userId: 'u-a' } });
  const [request] = fetchImpl.calls.filter(isWorkCall);
  assert.equal(request.url, 'https://api-dev.mittr.asia/desktop/work');
  assert.equal(request.headers.authorization, 'Bearer at-1');
});

const filesUnder = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? filesUnder(full) : [full];
});

const isIntegrationsCall = (request) => new URL(request.url).pathname === '/api/integrations';
const WORK_TRACKING = {
  jira: { baseUrl: 'https://x.atlassian.net', email: 'a@x', hasToken: true, configured: true },
  plane: { baseUrl: 'https://plane.example', workspaceSlug: 'mittr', hasApiKey: true, configured: true },
};

test('Work tracking settings answer signed out, then go to the signed-in account and are refused for another', async (t) => {
  const fetchImpl = fakeEngineFetch({
    other: (request) => {
      if (isIntegrationsCall(request)) return json({ ...WORK_TRACKING, slack: { configured: true } });
      if (isCatalogCall(request)) return json(CATALOG_A);
      return json(session);
    },
  });
  const { call, dataDir, logger } = await setUp(t, { fetchImpl });
  assert.deepEqual(await call('GET', '/api/mittr/integrations'), { status: 401, body: { error: 'Sign in to Mittr first' } });
  assert.equal(fetchImpl.calls.filter(isIntegrationsCall).length, 0);

  assert.equal((await signIn(call)).status, 200);
  assert.deepEqual(await call('GET', '/api/mittr/integrations'), { status: 200, body: { ...WORK_TRACKING, userId: 'u-a' } });
  const jira = { baseUrl: 'https://x.atlassian.net', email: 'a@x', token: 'jira-secret-123' };
  const plane = { baseUrl: 'https://plane.example', workspaceSlug: 'mittr', apiKey: 'plane-secret-456' };
  assert.equal((await call('PUT', '/api/mittr/integrations', { expectUserId: 'u-a', jira, plane })).status, 200);
  assert.equal((await call('PUT', '/api/mittr/integrations', { expectUserId: 'u-b', jira })).status, 409);
  const [read, write] = fetchImpl.calls.filter(isIntegrationsCall);
  assert.equal(read.headers.authorization, 'Bearer at-1');
  assert.deepEqual(write.body, { jira, plane });
  assert.equal(fetchImpl.calls.filter(isIntegrationsCall).length, 2);

  const written = filesUnder(dataDir);
  assert.ok(written.length > 0, 'setup wrote nothing, so the scan proves nothing');
  for (const file of written) {
    const text = fs.readFileSync(file, 'utf8');
    for (const secret of ['jira-secret-123', 'plane-secret-456']) assert.equal(text.includes(secret), false, `${file} carries ${secret}`);
  }
  for (const line of [...logger.lines, ...logger.warnings, ...logger.errors]) {
    for (const secret of ['jira-secret-123', 'plane-secret-456']) assert.equal(line.includes(secret), false, 'the log carries a secret');
  }
});

test('a server that cannot add usage providers still starts, with one warning', async (t) => {
  const engine = fakeEngineContext();
  engine.context.registerQuotaProvider = () => { throw new Error('already registered'); };
  const { logger } = await setUp(t, { engine });
  assert.equal(logger.warnings.filter((line) => line.includes('usage providers')).length, 1);
});

test('Mittr is added to the usage providers after the engine listener, the last step of setup', async (t) => {
  const engine = fakeEngineContext();
  const app = serverLikeApp();
  const originalOnReady = engine.context.opencode.onReady;
  engine.context.opencode.onReady = (...args) => {
    assert.deepEqual(engine.quotaProviders, [], 'the usage provider was added before setup finished its other steps');
    return originalOnReady(...args);
  };
  const mittr = setupMittr({ app, express, dataDir: tempDataDir(t), logger: recordingLogger(), host: null, ...engine.context }, { env: DEV_ENV, fetchImpl: fakeFetch(() => json(session)), engineConfigDir: USER_CONFIG_DIR });
  t.after(() => mittr.dispose());
  assert.equal(engine.quotaProviders.length, 1);
});

const refusingPlatform = (body) => fakeFetch((request) => {
  if (request.url.endsWith('/chat/completions')) return json(body, 403);
  if (isCatalogCall(request)) return json(CATALOG_A);
  return json(session);
});

test('stale catalog triggers one sync per minute', async (t) => {
  let clock = NOW;
  const fetchImpl = refusingPlatform({ error: { code: 'agent_not_granted', message: 'agent_not_granted' } });
  const { call, dataDir } = await setUp(t, { fetchImpl, now: () => clock });
  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 1);

  const refused = async () => {
    const response = await askShim(call, shimKey(dataDir));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: { code: 'agent_not_granted', message: 'agent_not_granted' } });
  };
  await refused();
  await until(() => catalogCalls(fetchImpl).length === 2);
  clock += 10_000;
  await refused();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(catalogCalls(fetchImpl).length, 2);
  clock += 51_000;
  await refused();
  await until(() => catalogCalls(fetchImpl).length === 3);
});

test('a refusal nobody can name asks for no sync', async (t) => {
  const fetchImpl = refusingPlatform({ error: 'something_else' });
  const { call, dataDir } = await setUp(t, { fetchImpl });
  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 1);
  assert.equal((await askShim(call, shimKey(dataDir))).status, 403);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(catalogCalls(fetchImpl).length, 1);
});

test('an entitlement refusal shares the one sync per minute with a stale catalog', async (t) => {
  let clock = NOW;
  const fetchImpl = refusingPlatform({ error: { message: 'desktop_entitlement_required', code: 'forbidden' } });
  const { call, dataDir } = await setUp(t, { fetchImpl, now: () => clock });
  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 1);
  const ask = () => askShim(call, shimKey(dataDir), { model: 'a1', stream: false, messages: [] });
  assert.equal((await ask()).status, 403);
  assert.equal(catalogCalls(fetchImpl).length, 2);
  clock += 59_000;
  assert.equal((await ask()).status, 403);
  assert.equal(catalogCalls(fetchImpl).length, 2);
  clock += 1_000;
  assert.equal((await ask()).status, 403);
  assert.equal(catalogCalls(fetchImpl).length, 3);
});

test('a model withdrawn since the last sync is refused as withdrawn after one sync, and a model still offered as an entitlement refusal', async (t) => {
  const entitlement = { error: { message: 'desktop_entitlement_required', type: 'invalid_request_error', code: 'forbidden' } };
  let offered = CATALOG_A;
  const fetchImpl = platform({
    catalog: () => json(offered),
    answer: (request) => (request.url.endsWith('/chat/completions') ? json(entitlement, 403) : null),
  });
  const engine = fakeEngineContext();
  const { mittr, call, dataDir } = await setUp(t, { fetchImpl, engine });
  assert.equal((await signIn(call)).status, 200);
  await until(async () => (await mittrModelsOf(mittr)).length === 2);
  const synced = catalogCalls(fetchImpl).length;

  const slowApply = deferred();
  engine.refreshGate = slowApply.promise;
  const refreshesBefore = engine.refreshes.length;
  offered = { ...CATALOG_A, bundleVersion: 8, models: [{ alias: 'a1', label: 'Writer' }] };
  const withdrawn = await askShim(call, shimKey(dataDir), { model: 'a2', stream: false, messages: [] });
  assert.equal(withdrawn.status, 403);
  assert.deepEqual(await withdrawn.json(), { error: { message: 'agent_not_granted', type: 'invalid_request_error', code: 'agent_not_granted' } });
  assert.equal(catalogCalls(fetchImpl).length, synced + 1);

  slowApply.resolve();
  await until(() => engine.refreshes.length > refreshesBefore);
  await until(async () => JSON.stringify(await mittrModelsOf(mittr)) === JSON.stringify(['a1']));

  const kept = await askShim(call, shimKey(dataDir), { model: 'a1', stream: false, messages: [] });
  assert.equal(kept.status, 403);
  assert.deepEqual(await kept.json(), entitlement);
  assert.equal(catalogCalls(fetchImpl).length, synced + 1);
});

test('the engine hears a withdrawn model before the models are applied, however slow the apply is', async (t) => {
  const entitlement = { error: { message: 'desktop_entitlement_required', type: 'invalid_request_error', code: 'forbidden' } };
  let offered = CATALOG_A;
  const fetchImpl = platform({
    catalog: () => json(offered),
    answer: (request) => (request.url.endsWith('/chat/completions') ? json(entitlement, 403) : null),
  });
  const engine = fakeEngineContext();
  const { mittr, call, dataDir } = await setUp(t, { fetchImpl, engine });
  assert.equal((await signIn(call)).status, 200);
  await until(async () => (await mittrModelsOf(mittr)).length === 2);

  const neverApplied = deferred();
  engine.refreshGate = neverApplied.promise;
  t.after(() => neverApplied.resolve());
  const refreshesBefore = engine.refreshes.length;
  offered = { ...CATALOG_A, bundleVersion: 9, models: [{ alias: 'a1', label: 'Writer' }] };
  const started = Date.now();
  const response = await askShim(call, shimKey(dataDir), { model: 'a2', stream: false, messages: [] });
  assert.ok(Date.now() - started < 5_000);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'agent_not_granted');
  await until(() => engine.refreshes.length > refreshesBefore);
});

const keyOf = (userId) => crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16);
const catalogSkill = (name, version = '1.0.0') => ({ name, version, files: [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: ${name}\n---\nBody\n` }] });
const cachedWithSkills = (skills) => ({
  bundleVersion: 7,
  subject: null,
  models: { configured: true, items: [{ alias: 'a1', label: 'a1' }] },
  mcp: { configured: true, items: [] },
  skills: { configured: true, items: skills },
  knowledge: { configured: true, items: [] },
});
const MY_SKILL = '---\nname: mine\ndescription: mine\n---\nMine\n';
const engineConfigHome = (t) => {
  const dir = path.join(tempDataDir(t), 'opencode');
  fs.mkdirSync(path.join(dir, 'skills', 'mine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'mine', 'SKILL.md'), MY_SKILL);
  return dir;
};
const orgSkillsIn = (engineConfigDir) => {
  const root = path.join(engineConfigDir, 'skills');
  return fs.existsSync(root) ? fs.readdirSync(root).filter((name) => name.startsWith('mittr-')).sort() : [];
};
const accountMarkerIn = (engineConfigDir) => {
  try {
    return fs.readFileSync(path.join(engineConfigDir, 'skills', '.mittr-account'), 'utf8').trim();
  } catch {
    return null;
  }
};
const mySkillIn = (engineConfigDir) => fs.readFileSync(path.join(engineConfigDir, 'skills', 'mine', 'SKILL.md'), 'utf8');
const writeAccountIndex = (dataDir, accounts, active) => {
  fs.mkdirSync(path.join(dataDir, 'mittr-accounts'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'mittr-accounts', 'index.json'), JSON.stringify({ active, accounts }));
};
const recordingSecretStore = () => {
  const sealing = sealingStore();
  const uses = [];
  return {
    uses,
    available: () => { uses.push('available'); return true; },
    encrypt: (text) => { uses.push('encrypt'); return sealing.encrypt(text); },
    decrypt: (data) => { uses.push('decrypt'); return sealing.decrypt(data); },
  };
};
const withSkills = (catalog, skills) => ({ ...catalog, skills });

test('setup installs the first account\'s catalog skills from its cache without opening the keychain', async (t) => {
  const dataDir = tempDataDir(t);
  const engineConfigDir = engineConfigHome(t);
  writeAccountIndex(dataDir, [{ userId: 'u-a', displayName: 'A', home: null, signedIn: true }], 'u-a');
  fs.writeFileSync(path.join(dataDir, 'mittr-catalog.json'), JSON.stringify(cachedWithSkills([catalogSkill('card-analysis')])));
  const opened = [];
  const secretStore = {
    available: () => true,
    encrypt: () => { opened.push('encrypt'); throw new Error('the keychain was asked to seal'); },
    decrypt: () => { opened.push('decrypt'); throw new Error('the keychain was asked to open'); },
  };

  await setUp(t, { dataDir, engineConfigDir, host: { secretStore, deepLinks: deepLinkHost() } });

  assert.deepEqual(orgSkillsIn(engineConfigDir), ['mittr-card-analysis']);
  assert.equal(accountMarkerIn(engineConfigDir), keyOf('u-a'));
  assert.equal(mySkillIn(engineConfigDir), MY_SKILL);
  assert.deepEqual(opened, []);
});

test('setup has the account\'s skills in place before it returns, so before the engine\'s first config build and start', async (t) => {
  const dataDir = tempDataDir(t);
  const engineConfigDir = engineConfigHome(t);
  writeAccountIndex(dataDir, [{ userId: 'u-a', displayName: 'A', home: null, signedIn: true }], 'u-a');
  fs.writeFileSync(path.join(dataDir, 'mittr-catalog.json'), JSON.stringify(cachedWithSkills([catalogSkill('card-analysis')])));
  const engine = fakeEngineContext();
  const order = [];
  const mittr = setupMittr({ app: serverLikeApp(), express, dataDir, logger: recordingLogger(), ...engine.context }, { env: DEV_ENV, fetchImpl: fakeFetch(() => json(session)), engineConfigDir });
  t.after(() => mittr.dispose());
  order.push(`returned:${orgSkillsIn(engineConfigDir).join()}`);
  await mittr.managedConfig();
  order.push('first config build');
  await mittr.engineEnv();
  order.push('first start env');
  engine.fireReady();

  assert.deepEqual(order, ['returned:mittr-card-analysis', 'first config build', 'first start env']);
  assert.deepEqual(engine.restarts, []);
  assert.equal(accountMarkerIn(engineConfigDir), keyOf('u-a'));
});

test('a pending 1.x session removes the org skills at setup, and its carry installs its own', async (t) => {
  const dataDir = tempDataDir(t);
  const engineConfigDir = engineConfigHome(t);
  const secretStore = recordingSecretStore();
  fs.writeFileSync(path.join(dataDir, 'mittr-session'), sealingStore().encrypt(JSON.stringify(session)));
  fs.writeFileSync(path.join(dataDir, 'mittr-catalog.json'), JSON.stringify(cachedWithSkills([catalogSkill('card-analysis')])));
  fs.mkdirSync(path.join(engineConfigDir, 'skills', 'mittr-left-behind'));
  fs.writeFileSync(path.join(engineConfigDir, 'skills', 'mittr-left-behind', 'SKILL.md'), 'old');
  fs.writeFileSync(path.join(engineConfigDir, 'skills', 'mittr-left-behind', '.mittr-version'), '1\n');
  fs.writeFileSync(path.join(engineConfigDir, 'skills', '.mittr-account'), `${keyOf('someone-else')}\n`);

  const { call } = await setUp(t, { dataDir, engineConfigDir, fetchImpl: platform(), host: { secretStore, deepLinks: deepLinkHost() } });

  assert.deepEqual(orgSkillsIn(engineConfigDir), []);
  assert.equal(accountMarkerIn(engineConfigDir), null);
  assert.deepEqual(secretStore.uses, []);

  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: true, userId: 'u-a', displayName: 'A' });
  assert.deepEqual(orgSkillsIn(engineConfigDir), ['mittr-card-analysis']);
  assert.equal(accountMarkerIn(engineConfigDir), keyOf('u-a'));
  assert.equal(mySkillIn(engineConfigDir), MY_SKILL);
});

test('a sync installs the account\'s catalog skills, and signing out of the last account removes them', async (t) => {
  const engineConfigDir = engineConfigHome(t);
  const fetchImpl = platform({ catalogs: { 'at-1': withSkills(CATALOG_A, [catalogSkill('card-analysis'), catalogSkill('notes')]) } });
  const { call } = await setUp(t, { engineConfigDir, fetchImpl });

  assert.equal((await signIn(call)).status, 200);
  await until(() => orgSkillsIn(engineConfigDir).length === 2);
  assert.deepEqual(orgSkillsIn(engineConfigDir), ['mittr-card-analysis', 'mittr-notes']);
  assert.equal(accountMarkerIn(engineConfigDir), keyOf('u-a'));

  assert.equal((await call('DELETE', '/api/mittr/auth/session')).status, 200);
  assert.deepEqual(orgSkillsIn(engineConfigDir), []);
  assert.equal(accountMarkerIn(engineConfigDir), null);
  assert.equal(mySkillIn(engineConfigDir), MY_SKILL);
});

test('a switch reconciles the new account\'s skills before the engine restarts', async (t) => {
  const engineConfigDir = engineConfigHome(t);
  const fetchImpl = platform({
    sessions: [session, sessionB],
    catalogs: {
      'at-1': withSkills(CATALOG_A, [catalogSkill('card-analysis')]),
      'at-b': withSkills(CATALOG_B, [catalogSkill('planning')]),
    },
  });
  const dataHomeOf = (home) => `/engine-data/${home ?? 'shared'}`;
  const engine = fakeEngineContext();
  engine.launchedDataHome = dataHomeOf('none');
  const atRestart = [];
  const { mittr, call } = await setUp(t, { engineConfigDir, engine, fetchImpl, engineDataHome: dataHomeOf });
  engine.onRestart = () => {
    atRestart.push({ skills: orgSkillsIn(engineConfigDir), marker: accountMarkerIn(engineConfigDir) });
    engine.launchedDataHome = dataHomeOf(mittr.engineHome());
  };

  assert.equal((await signIn(call)).status, 200);
  await until(() => orgSkillsIn(engineConfigDir).join() === 'mittr-card-analysis');
  assert.equal((await signIn(call)).status, 200);
  await until(() => orgSkillsIn(engineConfigDir).join() === 'mittr-planning');
  assert.equal(accountMarkerIn(engineConfigDir), keyOf('u-b'));
  assert.deepEqual(atRestart.at(-1), { skills: [], marker: null });

  const held = deferred();
  const restarts = atRestart.length;
  fetchImpl.calls.length = 0;
  engine.onRestart = () => {
    atRestart.push({ skills: orgSkillsIn(engineConfigDir), marker: accountMarkerIn(engineConfigDir) });
    engine.launchedDataHome = dataHomeOf(mittr.engineHome());
    return held.promise;
  };
  const switched = call('POST', '/api/mittr/auth/accounts/activate', { userId: 'u-a' });
  await until(() => atRestart.length > restarts);
  assert.deepEqual(atRestart.at(-1), { skills: ['mittr-card-analysis'], marker: keyOf('u-a') });
  assert.equal(catalogCalls(fetchImpl).length, 0);
  held.resolve();
  assert.equal((await switched).status, 200);
  assert.equal(mySkillIn(engineConfigDir), MY_SKILL);
});

test('turning a catalog skill off removes it at once, and turning it on brings it back', async (t) => {
  const engineConfigDir = engineConfigHome(t);
  const fetchImpl = platform({ catalogs: { 'at-1': withSkills(CATALOG_A, [catalogSkill('card-analysis'), catalogSkill('notes')]) } });
  const { call } = await setUp(t, { engineConfigDir, fetchImpl });
  assert.equal((await signIn(call)).status, 200);
  await until(() => orgSkillsIn(engineConfigDir).length === 2);

  assert.deepEqual(await call('PUT', '/api/mittr/catalog/enablement', { kind: 'skills', name: 'card-analysis', enabled: false }), { status: 200, body: { ok: true } });
  assert.deepEqual(orgSkillsIn(engineConfigDir), ['mittr-notes']);

  assert.equal((await call('POST', '/api/mittr/catalog/sync')).status, 200);
  assert.deepEqual(orgSkillsIn(engineConfigDir), ['mittr-notes']);

  assert.deepEqual(await call('PUT', '/api/mittr/catalog/enablement', { kind: 'skills', name: 'card-analysis', enabled: true }), { status: 200, body: { ok: true } });
  assert.deepEqual(orgSkillsIn(engineConfigDir), ['mittr-card-analysis', 'mittr-notes']);
});

test('a toggle whose skills cannot be applied answers applied false, and the next sync applies them', async (t) => {
  const engineConfigDir = path.join(tempDataDir(t), 'opencode');
  fs.mkdirSync(engineConfigDir, { recursive: true });
  const fetchImpl = platform({ catalogs: { 'at-1': withSkills(CATALOG_A, [catalogSkill('card-analysis')]) } });
  fs.writeFileSync(path.join(engineConfigDir, 'skills'), 'not a folder');
  const { call, logger } = await setUp(t, { engineConfigDir, fetchImpl });
  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 1);

  assert.deepEqual(await call('PUT', '/api/mittr/catalog/enablement', { kind: 'skills', name: 'card-analysis', enabled: true }), { status: 200, body: { ok: true, applied: false } });
  assert.ok(logger.warnings.some((line) => line.includes('applying the catalog enablement failed')));

  fs.rmSync(path.join(engineConfigDir, 'skills'));
  assert.equal((await call('POST', '/api/mittr/catalog/sync')).status, 200);
  assert.deepEqual(orgSkillsIn(engineConfigDir), ['mittr-card-analysis']);
});

test('a toggled skill that could not be written answers applied false and names the skill in the log', async (t) => {
  const engineConfigDir = engineConfigHome(t);
  const fetchImpl = platform({ catalogs: { 'at-1': withSkills(CATALOG_A, [catalogSkill('mine'), catalogSkill('notes')]) } });
  const { call, logger } = await setUp(t, { engineConfigDir, fetchImpl });
  fs.mkdirSync(path.join(engineConfigDir, 'skills', 'mittr-mine'));
  fs.writeFileSync(path.join(engineConfigDir, 'skills', 'mittr-mine', 'SKILL.md'), MY_SKILL);
  assert.equal((await signIn(call)).status, 200);
  await until(() => orgSkillsIn(engineConfigDir).includes('mittr-notes'));
  assert.ok(logger.warnings.some((line) => line.includes("'mittr-mine'")));

  assert.deepEqual(await call('PUT', '/api/mittr/catalog/enablement', { kind: 'skills', name: 'mine', enabled: true }), { status: 200, body: { ok: true, applied: false } });
  assert.deepEqual(await call('PUT', '/api/mittr/catalog/enablement', { kind: 'skills', name: 'notes', enabled: true }), { status: 200, body: { ok: true } });
  assert.equal(fs.readFileSync(path.join(engineConfigDir, 'skills', 'mittr-mine', 'SKILL.md'), 'utf8'), MY_SKILL);
});

const mcpConnector = (name, ...command) => ({ name, config: { type: 'local', command } });
const withMcp = (catalog, items) => ({ ...catalog, mcp: items });
const cachedWithMcp = (items) => ({ ...cachedWithSkills([]), mcp: { configured: true, items } });
const MY_SERVERS = { mine: { type: 'local', command: ['my-own-mcp'] }, 'mittr-foo': { type: 'remote', url: 'https://my-own.example/mcp' } };
const noConnectorWrites = (engine) => engine.userConfigWrites.every(({ config }) => Object.keys(config.mcp?.servers ?? {}).every((name) => Object.hasOwn(MY_SERVERS, name))
  && Object.keys(config.mcp ?? {}).every((name) => !name.startsWith('mittr-')));

const desktopHost = () => ({ secretStore: sealingStore(), deepLinks: deepLinkHost() });

const managedFileOnDisk = (t, engine) => {
  const runtime = createManagedConfigRuntime({
    fsPromises: fs.promises,
    path,
    dataDir: tempDataDir(t),
    env: {},
    readSettings: async () => ({}),
    isAgentMemoryAvailable: () => false,
    contributeConfig: () => engine.contribute(),
  });
  const disk = {
    fail: null,
    start: () => runtime.buildManagedChildEnv(),
    read: () => (fs.existsSync(runtime.filePath) ? JSON.parse(fs.readFileSync(runtime.filePath, 'utf8')) : null),
    mcp: () => Object.keys(disk.read()?.mcp?.servers ?? {}).sort(),
    mode: () => fs.statSync(runtime.filePath).mode & 0o777,
  };
  engine.context.managedConfig.refresh = async () => {
    engine.refreshes.push(Date.now());
    if (disk.fail) throw disk.fail;
    return runtime.refreshManagedConfigFile();
  };
  return disk;
};

test('setup has the first account\'s catalog connectors in the managed file from the index alone, and never in the user config', async (t) => {
  const dataDir = tempDataDir(t);
  writeAccountIndex(dataDir, [{ userId: 'u-a', displayName: 'A', home: null, signedIn: true }], 'u-a');
  fs.writeFileSync(path.join(dataDir, 'mittr-catalog.json'), JSON.stringify(cachedWithMcp([mcpConnector('iApp Thai Legal', 'npx', '-y', 'acme-legal')])));
  const opened = [];
  const secretStore = {
    available: () => true,
    encrypt: () => { opened.push('encrypt'); throw new Error('the keychain was asked to seal'); },
    decrypt: () => { opened.push('decrypt'); throw new Error('the keychain was asked to open'); },
  };
  const engine = fakeEngineContext({ userConfigFile: { mcp: { servers: MY_SERVERS } } });
  const disk = managedFileOnDisk(t, engine);

  await setUp(t, { dataDir, engine, built: false, host: { secretStore, deepLinks: deepLinkHost() } });
  await disk.start();

  assert.deepEqual(disk.mcp(), ['mittr-iapp-thai-legal']);
  assert.deepEqual(disk.read().mcp.servers['mittr-iapp-thai-legal'], { type: 'local', command: ['npx', '-y', 'acme-legal'] });
  if (process.platform !== 'win32') assert.equal(disk.mode(), 0o600);
  assert.deepEqual(engine.userConfigFile.mcp, { servers: MY_SERVERS });
  assert.ok(noConnectorWrites(engine));
  assert.equal(fs.existsSync(path.join(dataDir, 'mittr-mcp-owned.json')), false);
  assert.deepEqual(opened, []);
});

test('a sync writes the account\'s connectors into the managed file, and signing out of the last account writes it without them', async (t) => {
  const engine = fakeEngineContext({ userConfigFile: { mcp: { servers: MY_SERVERS } } });
  const disk = managedFileOnDisk(t, engine);
  const fetchImpl = platform({ catalogs: { 'at-1': withMcp(CATALOG_A, [mcpConnector('docs', 'docs-mcp'), mcpConnector('law', 'law-mcp')]) } });
  const { call } = await setUp(t, { host: desktopHost(), engine, fetchImpl });

  assert.equal((await signIn(call)).status, 200);
  await until(() => disk.mcp().length === 2);
  assert.deepEqual(disk.mcp(), ['mittr-docs', 'mittr-law']);

  assert.equal((await call('DELETE', '/api/mittr/auth/session')).status, 200);
  await until(() => disk.mcp().length === 0);
  assert.notEqual(disk.read(), null);
  assert.deepEqual(engine.userConfigFile.mcp, { servers: MY_SERVERS });
  assert.ok(noConnectorWrites(engine));
});

test('a switch has only the new account\'s connectors in the managed file before the engine restarts', async (t) => {
  const fetchImpl = platform({
    sessions: [session, sessionB],
    catalogs: { 'at-1': withMcp(CATALOG_A, [mcpConnector('x', 'x-mcp')]), 'at-b': withMcp(CATALOG_B, [mcpConnector('y', 'y-mcp')]) },
  });
  const dataHomeOf = (home) => `/engine-data/${home ?? 'shared'}`;
  const engine = fakeEngineContext();
  const disk = managedFileOnDisk(t, engine);
  engine.launchedDataHome = dataHomeOf('none');
  const atRestart = [];
  const { mittr, call } = await setUp(t, { host: desktopHost(), engine, fetchImpl, engineDataHome: dataHomeOf });
  engine.onRestart = () => {
    atRestart.push(disk.mcp());
    engine.launchedDataHome = dataHomeOf(mittr.engineHome());
  };

  assert.equal((await signIn(call)).status, 200);
  await until(() => disk.mcp().join() === 'mittr-x');
  assert.equal((await signIn(call)).status, 200);
  await until(() => disk.mcp().join() === 'mittr-y');
  assert.deepEqual(atRestart.at(-1), []);

  for (const [userId, expected] of [['u-a', ['mittr-x']], ['u-b', ['mittr-y']]]) {
    const restarts = atRestart.length;
    assert.equal((await call('POST', '/api/mittr/auth/accounts/activate', { userId })).status, 200);
    assert.ok(atRestart.length > restarts);
    assert.deepEqual(atRestart.at(-1), expected, userId);
    assert.deepEqual(disk.mcp(), expected, userId);
  }
  assert.ok(noConnectorWrites(engine));
});

test('a catalog whose only change is a connector rewrites the managed file once', async (t) => {
  let offered = CATALOG_A;
  const fetchImpl = platform({ catalog: () => json(offered) });
  const engine = fakeEngineContext();
  const disk = managedFileOnDisk(t, engine);
  const { mittr, call } = await setUp(t, { host: desktopHost(), engine, fetchImpl });
  assert.equal((await signIn(call)).status, 200);
  await until(async () => (await mittrModelsOf(mittr)).length === 2);
  assert.equal((await call('POST', '/api/mittr/catalog/sync')).status, 200);
  const before = engine.refreshes.length;
  assert.equal((await call('POST', '/api/mittr/catalog/sync')).status, 200);
  assert.equal(engine.refreshes.length, before);

  offered = withMcp(CATALOG_A, [mcpConnector('docs', 'docs-mcp')]);
  assert.equal((await call('POST', '/api/mittr/catalog/sync')).status, 200);
  assert.equal(engine.refreshes.length, before + 1);
  assert.deepEqual(disk.mcp(), ['mittr-docs']);
});

test('turning a catalog connector off takes it out of the managed file at once, and on brings it back', async (t) => {
  const engine = fakeEngineContext();
  const disk = managedFileOnDisk(t, engine);
  const fetchImpl = platform({ catalogs: { 'at-1': withMcp(CATALOG_A, [mcpConnector('docs', 'docs-mcp'), mcpConnector('law', 'law-mcp')]) } });
  const { call } = await setUp(t, { host: desktopHost(), engine, fetchImpl });
  assert.equal((await signIn(call)).status, 200);
  await until(() => disk.mcp().length === 2);

  assert.deepEqual(await call('PUT', '/api/mittr/catalog/enablement', { kind: 'mcp', name: 'docs', enabled: false }), { status: 200, body: { ok: true } });
  assert.deepEqual(disk.mcp(), ['mittr-law']);
  assert.equal((await call('POST', '/api/mittr/catalog/sync')).status, 200);
  assert.deepEqual(disk.mcp(), ['mittr-law']);

  assert.deepEqual(await call('PUT', '/api/mittr/catalog/enablement', { kind: 'mcp', name: 'docs', enabled: true }), { status: 200, body: { ok: true } });
  assert.deepEqual(disk.mcp(), ['mittr-docs', 'mittr-law']);
});

test('a toggle answers applied false when the connector is left out or the managed file cannot be written, and the next sync applies it', async (t) => {
  const engine = fakeEngineContext({ userConfigFile: { mcp: { servers: MY_SERVERS } } });
  const disk = managedFileOnDisk(t, engine);
  const fetchImpl = platform({ catalogs: { 'at-1': withMcp(CATALOG_A, [mcpConnector('foo', 'org-foo'), mcpConnector('docs', 'docs-mcp')]) } });
  const { call, logger } = await setUp(t, { host: desktopHost(), engine, fetchImpl });
  assert.equal((await signIn(call)).status, 200);
  await until(() => disk.mcp().includes('mittr-docs'));
  assert.deepEqual(disk.mcp(), ['mittr-docs']);

  assert.deepEqual(await call('PUT', '/api/mittr/catalog/enablement', { kind: 'mcp', name: 'foo', enabled: true }), { status: 200, body: { ok: true, applied: false } });
  assert.deepEqual(await call('PUT', '/api/mittr/catalog/enablement', { kind: 'mcp', name: 'docs', enabled: true }), { status: 200, body: { ok: true } });

  disk.fail = new Error('disk full');
  assert.deepEqual(await call('PUT', '/api/mittr/catalog/enablement', { kind: 'mcp', name: 'docs', enabled: false }), { status: 200, body: { ok: true, applied: false } });
  assert.ok(logger.warnings.some((line) => line.includes('applying the catalog enablement failed')));
  assert.deepEqual(disk.mcp(), ['mittr-docs']);
  disk.fail = null;
  assert.equal((await call('POST', '/api/mittr/catalog/sync')).status, 200);
  assert.deepEqual(disk.mcp(), []);
  assert.deepEqual(engine.userConfigFile.mcp, { servers: MY_SERVERS });
});

test('a name the person\'s own user config or engine config folder already holds is left out, and those files are only read', async (t) => {
  const engineConfigDir = path.join(tempDataDir(t), 'opencode');
  fs.mkdirSync(engineConfigDir, { recursive: true });
  const jsonc = '{\n  // my own\n  "mcp": { "servers": { "mittr-bar": { "type": "local", "command": ["my-bar"] } } },\n}\n';
  fs.writeFileSync(path.join(engineConfigDir, 'opencode.jsonc'), jsonc);
  const legacy = { type: 'local', command: ['old'] };
  const engine = fakeEngineContext({ userConfigFile: { mcp: { servers: MY_SERVERS, 'mittr/legacy': legacy } } });
  const disk = managedFileOnDisk(t, engine);
  const fetchImpl = platform({ catalogs: { 'at-1': withMcp(CATALOG_A, ['foo', 'bar', 'docs'].map((name) => mcpConnector(name, `org-${name}`, 'org-secret'))) } });
  const { call, logger } = await setUp(t, { host: desktopHost(), engine, fetchImpl, engineConfigDir });

  assert.equal((await signIn(call)).status, 200);
  await until(() => disk.mcp().length > 0);
  assert.deepEqual(disk.mcp(), ['mittr-docs']);
  const leftOut = logger.warnings.filter((line) => line.includes('was left out'));
  assert.ok(leftOut.some((line) => line.includes("'foo'")) && leftOut.some((line) => line.includes("'bar'")), leftOut.join('\n'));
  assert.equal(leftOut.some((line) => /org-|my-bar|my-own/.test(line)), false);
  assert.equal(fs.readFileSync(path.join(engineConfigDir, 'opencode.jsonc'), 'utf8'), jsonc);
  assert.deepEqual(engine.userConfigWrites, []);
  assert.deepEqual(engine.userConfigFile.mcp['mittr/legacy'], legacy);
});

test('a name the person\'s own OPENCODE_CONFIG file or OPENCODE_CONFIG_CONTENT holds is left out, and the file is only read', async (t) => {
  const dataDir = tempDataDir(t);
  const ownFile = path.join(tempDataDir(t), 'my-opencode.jsonc');
  const ownText = '{\n  // mine\n  "mcp": { "servers": { "mittr-own": { "type": "local", "command": ["my-own"] } } }\n}\n';
  fs.writeFileSync(ownFile, ownText);
  const content = JSON.stringify({ mcp: { 'mittr-content': { type: 'remote', url: 'https://mine.example/mcp' } } });
  const engine = fakeEngineContext();
  const disk = managedFileOnDisk(t, engine);
  const fetchImpl = platform({ catalogs: { 'at-1': withMcp(CATALOG_A, ['own', 'content', 'docs'].map((name) => mcpConnector(name, `org-${name}`))) } });
  const { call, logger } = await setUp(t, { host: desktopHost(), dataDir, engine, fetchImpl, env: { ...DEV_ENV, OPENCODE_CONFIG: ownFile, OPENCODE_CONFIG_CONTENT: content } });

  assert.equal((await signIn(call)).status, 200);
  await until(() => disk.mcp().length > 0);
  assert.deepEqual(disk.mcp(), ['mittr-docs']);
  const leftOut = logger.warnings.filter((line) => line.includes('was left out'));
  assert.deepEqual(leftOut.map((line) => line.match(/'([^']+)'/)[1]).sort(), ['content', 'own']);
  assert.equal(leftOut.some((line) => /org-|my-own|mine\.example/.test(line)), false);
  assert.equal(fs.readFileSync(ownFile, 'utf8'), ownText);
  assert.ok(noConnectorWrites(engine));
});

test('an OPENCODE_CONFIG that names the managed file itself does not hide the catalog connectors', async (t) => {
  const dataDir = tempDataDir(t);
  const managedFile = path.join(dataDir, 'opencode.managed.json');
  fs.writeFileSync(managedFile, JSON.stringify({ mcp: { servers: { 'mittr-docs': { type: 'local', command: ['org-docs'] } } } }));
  const engine = fakeEngineContext();
  const disk = managedFileOnDisk(t, engine);
  const fetchImpl = platform({ catalogs: { 'at-1': withMcp(CATALOG_A, [mcpConnector('docs', 'org-docs')]) } });
  const { call } = await setUp(t, { host: desktopHost(), dataDir, engine, fetchImpl, env: { ...DEV_ENV, OPENCODE_CONFIG: managedFile } });
  assert.equal((await signIn(call)).status, 200);
  await until(() => disk.mcp().length > 0);
  assert.deepEqual(disk.mcp(), ['mittr-docs']);
});

test('a pending 1.x session renders no connector and clears 1.22\'s mittr/ entries at setup, and its carry renders its own', async (t) => {
  const dataDir = tempDataDir(t);
  const secretStore = recordingSecretStore();
  fs.writeFileSync(path.join(dataDir, 'mittr-session'), sealingStore().encrypt(JSON.stringify(session)));
  fs.writeFileSync(path.join(dataDir, 'mittr-catalog.json'), JSON.stringify(cachedWithMcp([mcpConnector('docs', 'docs-mcp')])));
  const engine = fakeEngineContext({ userConfigFile: { mcp: { servers: MY_SERVERS, 'mittr/legacy': { type: 'local', command: ['old'] } } } });
  const disk = managedFileOnDisk(t, engine);

  const { call, logger } = await setUp(t, { dataDir, engine, fetchImpl: platform(), host: { secretStore, deepLinks: deepLinkHost() } });
  await disk.start();

  assert.deepEqual(disk.mcp(), []);
  assert.deepEqual(engine.userConfigFile.mcp, { servers: MY_SERVERS });
  assert.ok(logger.lines.some((line) => line.includes('mittr/legacy')));
  assert.deepEqual(secretStore.uses, []);

  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: true, userId: 'u-a', displayName: 'A' });
  await until(() => disk.mcp().length === 1);
  assert.deepEqual(disk.mcp(), ['mittr-docs']);
});

const SECRETS = ['SEKRET-H1', 'SEKRET-E1', 'SEKRET-E2', 'SEKRET-H2', 'SEKRET-E3', 'SEKRET-ARG'];
const SECRET_CATALOG = withMcp(CATALOG_A, [
  { name: 'remote', config: { type: 'remote', url: 'https://acme.example/mcp', headers: { authorization: 'Bearer SEKRET-H1' } } },
  { name: 'local', config: { type: 'local', command: ['acme-mcp', '--token=SEKRET-ARG'], environment: { ACME_KEY: 'SEKRET-E1' } } },
  { name: 'broken', config: { command: ['acme-mcp'], environment: { ACME_KEY: 'SEKRET-E2' } } },
  { name: 'Remote', config: { type: 'remote', url: 'https://acme.example/other', headers: { authorization: 'Bearer SEKRET-H2' } } },
  { name: 'foo', config: { type: 'local', command: ['acme-mcp'], environment: { ACME_KEY: 'SEKRET-E3' } } },
]);

test('no connector header, env value or argument reaches a log line, an error or a mittr route\'s answer', async (t) => {
  const engine = fakeEngineContext({ userConfigFile: { mcp: { servers: MY_SERVERS } } });
  const disk = managedFileOnDisk(t, engine);
  const fetchImpl = platform({ catalogs: { 'at-1': SECRET_CATALOG } });
  const { call, logger, dataDir } = await setUp(t, { host: desktopHost(), engine, fetchImpl });
  const answers = [];
  const ask = async (method, route, body) => {
    const answer = await call(method, route, body);
    answers.push(JSON.stringify(answer));
    return answer;
  };

  answers.push(JSON.stringify(await signIn(call)));
  await until(() => disk.mcp().length === 2);
  assert.deepEqual(disk.mcp(), ['mittr-local', 'mittr-remote']);
  await ask('POST', '/api/mittr/catalog/sync');
  for (const name of ['remote', 'local', 'broken', 'Remote', 'foo']) {
    await ask('PUT', '/api/mittr/catalog/enablement', { kind: 'mcp', name, enabled: false });
    await ask('PUT', '/api/mittr/catalog/enablement', { kind: 'mcp', name, enabled: true });
  }
  disk.fail = new Error('disk full');
  await ask('PUT', '/api/mittr/catalog/enablement', { kind: 'mcp', name: 'local', enabled: true });
  disk.fail = null;
  for (const route of ['/api/mittr/auth/status', '/api/mittr/auth/accounts', '/api/mittr/quota/me', '/api/mittr/answered-by']) await ask('GET', route);
  await ask('PUT', '/api/mittr/catalog/enablement', { kind: 'nope', name: 'local' });

  const lines = [...logger.lines, ...logger.warnings, ...logger.errors];
  assert.ok(lines.some((line) => line.includes("'broken'")) && lines.some((line) => line.includes("'Remote'")) && lines.some((line) => line.includes("'foo'")), lines.join('\n'));
  for (const secret of SECRETS) {
    assert.equal(lines.some((line) => line.includes(secret)), false, `a log line holds ${secret}`);
    assert.equal(answers.some((answer) => answer.includes(secret)), false, `a route answer holds ${secret}`);
  }
  const caches = catalogFiles(dataDir).map((name) => path.join(dataDir, 'mittr-accounts', name));
  assert.equal(caches.length, 1);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(caches[0]).mode & 0o777, 0o600, 'the catalog cache, which holds the connector configs, is not private');
    assert.equal(disk.mode(), 0o600, 'the managed file, which holds the connector configs, is not private');
  }
  assert.ok(noConnectorWrites(engine));
});

test('GET /api/mittr/catalog answers no connector header, env value, argument or url path', async (t) => {
  const fetchImpl = platform({ catalogs: { 'at-1': SECRET_CATALOG } });
  const { call } = await setUp(t, { fetchImpl });
  assert.equal((await signIn(call)).status, 200);
  await until(() => catalogCalls(fetchImpl).length === 1);
  const catalog = await call('GET', '/api/mittr/catalog');
  const answer = JSON.stringify(catalog);
  for (const secret of [...SECRETS, '/mcp', '/other']) assert.equal(answer.includes(secret), false, secret);
  assert.deepEqual(catalog.body.mcp.items, [
    { name: 'remote', type: 'remote', host: 'acme.example', enabled: true },
    { name: 'local', type: 'local', enabled: true },
    { name: 'broken', enabled: true },
    { name: 'Remote', type: 'remote', host: 'acme.example', enabled: true },
    { name: 'foo', type: 'local', enabled: true },
  ]);
});

const HOSTED_LINE = '[mittr] catalog connectors are off on hosted web until an administrator decides how their secrets are protected';
const hostedLines = (logger) => [...logger.lines, ...logger.warnings, ...logger.errors].filter((line) => line === HOSTED_LINE);
const HOSTED_CATALOG = withSkills(withMcp(CATALOG_A, [mcpConnector('docs', 'docs-mcp')]), [catalogSkill('notes')]);

test('a hosted runtime renders no catalog connector and logs once', async (t) => {
  for (const [runtime, options] of [
    ['the server with no desktop host', { host: null }],
    ['a desktop server with a UI password', { host: desktopHost(), uiAuth: { passwordEnabled: () => true } }],
    ['a desktop server with company sign-in', { host: desktopHost(), companySignIn: true }],
  ]) {
    const engineConfigDir = engineConfigHome(t);
    const engine = fakeEngineContext();
    const disk = managedFileOnDisk(t, engine);
    const fetchImpl = platform({ catalogs: { 'at-1': HOSTED_CATALOG } });
    const { mittr, call, logger } = await setUp(t, { ...options, engine, engineConfigDir, fetchImpl });

    assert.equal((await signIn(call)).status, 200, runtime);
    await until(() => disk.read() !== null && orgSkillsIn(engineConfigDir).includes('mittr-notes'));
    assert.equal((await call('POST', '/api/mittr/catalog/sync')).status, 200, runtime);
    assert.deepEqual(disk.mcp(), [], runtime);
    assert.deepEqual(Object.keys(disk.read().providers?.mittr?.models ?? {}).sort(), ['a1', 'a2'], runtime);
    assert.deepEqual(orgSkillsIn(engineConfigDir), ['mittr-notes'], runtime);

    assert.deepEqual((await call('GET', '/api/mittr/catalog')).body.mcp.items, [{ name: 'docs', type: 'local', enabled: true }], runtime);
    assert.deepEqual(await call('PUT', '/api/mittr/catalog/enablement', { kind: 'mcp', name: 'docs', enabled: false }), { status: 200, body: { ok: true } }, runtime);
    assert.deepEqual((await call('GET', '/api/mittr/catalog')).body.mcp.items, [{ name: 'docs', type: 'local', enabled: false }], runtime);
    assert.deepEqual(await call('PUT', '/api/mittr/catalog/enablement', { kind: 'mcp', name: 'docs', enabled: true }), { status: 200, body: { ok: true } }, runtime);
    assert.equal((await mittr.managedConfig()).mcp, undefined, runtime);
    assert.deepEqual(disk.mcp(), [], runtime);
    assert.equal(hostedLines(logger).length, 1, runtime);
  }
});

test('the desktop runtime still renders the account\'s connectors', async (t) => {
  const engineConfigDir = engineConfigHome(t);
  const engine = fakeEngineContext();
  const disk = managedFileOnDisk(t, engine);
  const fetchImpl = platform({ catalogs: { 'at-1': HOSTED_CATALOG } });
  const { call, logger } = await setUp(t, { host: desktopHost(), uiAuth: { passwordEnabled: () => false }, engine, engineConfigDir, fetchImpl });

  assert.equal((await signIn(call)).status, 200);
  await until(() => disk.mcp().length === 1);
  assert.deepEqual(disk.mcp(), ['mittr-docs']);
  assert.deepEqual(orgSkillsIn(engineConfigDir), ['mittr-notes']);
  assert.deepEqual(await call('PUT', '/api/mittr/catalog/enablement', { kind: 'mcp', name: 'docs', enabled: false }), { status: 200, body: { ok: true } });
  assert.deepEqual(disk.mcp(), []);
  assert.deepEqual(hostedLines(logger), []);
});

test('the hosted signal is fixed at start', async (t) => {
  let passwordOn = true;
  for (const options of [{ host: null }, { host: desktopHost(), uiAuth: { passwordEnabled: () => passwordOn } }]) {
    passwordOn = true;
    const env = { ...DEV_ENV };
    const engine = fakeEngineContext();
    const disk = managedFileOnDisk(t, engine);
    const fetchImpl = platform({ catalogs: { 'at-1': HOSTED_CATALOG } });
    const { mittr, call, logger } = await setUp(t, { ...options, env, engine, fetchImpl });

    passwordOn = false;
    Object.assign(env, { OPENCHAMBER_RUNTIME: 'desktop', OPENCHAMBER_DESKTOP: '1', ELECTRON_RUN_AS_NODE: '1', MITTRCRAFT_DESKTOP: '1' });
    delete env.MITTRCRAFT_BROKER_URL;
    const desktopHeaders = {
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 MittrCraft/2.0.0 Electron/38.0.0',
      origin: 'openchamber-ui://app',
      'x-openchamber-runtime': 'desktop',
      'x-forwarded-for': '127.0.0.1',
    };
    const send = (method, route, body) => fetch(call.base + route, { method, headers: desktopHeaders, body: body === undefined ? undefined : JSON.stringify(body) });

    assert.equal((await signIn(call)).status, 200);
    await until(() => disk.read() !== null);
    assert.equal((await send('POST', '/api/mittr/catalog/sync')).status, 200);
    assert.equal((await send('PUT', '/api/mittr/catalog/enablement', { kind: 'mcp', name: 'docs', enabled: false })).status, 200);
    assert.equal((await send('PUT', '/api/mittr/catalog/enablement', { kind: 'mcp', name: 'docs', enabled: true })).status, 200);
    await engine.context.managedConfig.refresh();

    assert.equal((await mittr.managedConfig()).mcp, undefined);
    assert.deepEqual(disk.mcp(), []);
    assert.equal(hostedLines(logger).length, 1);
  }
});

const TOOL_DRIVERS = { computer: () => '/r/cua-driver/cua-driver', chrome: () => '/r/agent-browser/agent-browser', chromePath: () => CHROME_EXECUTABLE };
const toolNamesIn = (dataDir) => {
  const file = path.join(toolsDirOf(dataDir), 'index.js');
  return fs.existsSync(file) ? [...fs.readFileSync(file, 'utf8').matchAll(/name: "(mittrcraft_[a-z]+)"/g)].map((match) => match[1]) : [];
};

test('the tools plugin is loaded after the identity plugin, and turning Chrome off rewrites the config once through the queue', async (t) => {
  const engine = fakeEngineContext();
  const { mittr, dataDir } = await setUp(t, { engine, host: desktopHost(), toolDrivers: TOOL_DRIVERS });
  assert.deepEqual((await mittr.managedConfig()).plugins, [identityDirOf(dataDir), toolsDirOf(dataDir)]);
  assert.deepEqual(toolNamesIn(dataDir), ['mittrcraft_computer', 'mittrcraft_chrome']);
  const before = engine.refreshes.length;

  assert.deepEqual(await mittr.tools.applySwitches({ chrome: false }), { computer: true, chrome: false });

  assert.equal(engine.refreshes.length, before + 1);
  assert.deepEqual(toolNamesIn(dataDir), ['mittrcraft_computer']);
  assert.deepEqual(engine.rendered.at(-1).plugins, [identityDirOf(dataDir), toolsDirOf(dataDir)]);

  await mittr.tools.applySwitches({ computer: false });
  assert.deepEqual(engine.rendered.at(-1).plugins, [identityDirOf(dataDir), toolsDirOf(dataDir)], 'with every Mittr tool off the plugin still wraps the panel capture');
  assert.deepEqual(toolNamesIn(dataDir), []);

  engine.upstreamSettings = { agentWebToolEnabled: false };
  assert.deepEqual((await mittr.managedConfig()).plugins, [identityDirOf(dataDir)], 'with every tool off and the panel browser tool off the plugin is no longer loaded');
});

test('a change in the offered tools alone rewrites the config on the next model apply', async (t) => {
  const engine = fakeEngineContext();
  const chrome = { installed: false };
  const { mittr, dataDir } = await setUp(t, {
    engine,
    host: desktopHost(),
    toolDrivers: { ...TOOL_DRIVERS, chromePath: () => (chrome.installed ? CHROME_EXECUTABLE : null) },
    fetchImpl: engineAndBroker(),
  });
  await mittr.applyModels(MODELS);
  await mittr.applyModels(MODELS);
  assert.equal(engine.refreshes.length, 1);

  chrome.installed = true;
  await mittr.applyModels(MODELS);

  assert.equal(engine.refreshes.length, 2);
  assert.deepEqual(toolNamesIn(dataDir), ['mittrcraft_computer', 'mittrcraft_chrome']);
});

test('a hosted runtime, company sign-in or a UI password offers no computer or chrome tool', async (t) => {
  for (const options of [
    { host: null },
    { host: desktopHost(), companySignIn: true },
    { host: desktopHost(), uiAuth: { passwordEnabled: () => true } },
  ]) {
    const { mittr, dataDir } = await setUp(t, { ...options, toolDrivers: TOOL_DRIVERS });
    assert.deepEqual((await mittr.managedConfig()).plugins, [identityDirOf(dataDir), toolsDirOf(dataDir)], JSON.stringify(Object.keys(options)));
    assert.deepEqual(toolNamesIn(dataDir), []);
  }
});

test('the tools callback sits outside /api and answers a call from the engine with its env', async (t) => {
  const driver = stubAgentBrowser(t);
  const { mittr, call } = await setUp(t, { host: desktopHost(), toolDrivers: { ...TOOL_DRIVERS, chrome: () => driver.file } });
  const { MITTRCRAFT_TOOLS_URL: url, MITTRCRAFT_TOOLS_TOKEN: token } = await mittr.engineEnv();
  assert.equal(new URL(url).pathname, '/mittr-tools/v1/call');
  const response = await fetch(`${call.base}/mittr-tools/v1/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ tool: 'mittrcraft_chrome', input: { action: 'close' }, sessionID: 's1' }),
  });
  assert.deepEqual(await response.json(), { schemaVersion: 1, ok: true, action: 'chrome.close', data: { closed: true } });
});

test('an http control call runs a chrome action only from this machine', async (t) => {
  const engine = fakeEngineContext();
  const { call } = await setUp(t, { engine, host: desktopHost(), toolDrivers: TOOL_DRIVERS });
  assert.deepEqual(await call('POST', '/api/mittr/control', { action: 'chrome.open' }), { status: 400, body: { error: 'The Chrome tool needs the calling session' } });
  engine.scope = 'tunnel';
  assert.deepEqual(await call('POST', '/api/mittr/control', { action: 'chrome.open' }), { status: 403, body: { error: 'Open a page in Chrome can only be used from this machine' } });
});

test('a tools plugin whose first write failed is written by the next config write', async (t) => {
  const engine = fakeEngineContext();
  const dataDir = tempDataDir(t);
  const { mittr } = await setUp(t, {
    engine,
    dataDir,
    host: desktopHost(),
    toolDrivers: TOOL_DRIVERS,
    fetchImpl: engineAndBroker(),
    beforeBuild: () => {
      fs.mkdirSync(path.join(dataDir, 'engine-plugins'), { recursive: true });
      fs.writeFileSync(toolsDirOf(dataDir), 'in the way');
    },
  });
  await mittr.applyModels(MODELS);
  assert.equal(engine.refreshes.length, 1);
  assert.deepEqual(engine.rendered.at(-1).plugins, [identityDirOf(dataDir)]);

  fs.rmSync(toolsDirOf(dataDir));
  await mittr.applyModels(MODELS);

  assert.equal(engine.refreshes.length, 2);
  assert.deepEqual(engine.rendered.at(-1).plugins, [identityDirOf(dataDir), toolsDirOf(dataDir)]);
  assert.deepEqual(toolNamesIn(dataDir), ['mittrcraft_computer', 'mittrcraft_chrome']);
});

test('a switch change never restarts or reloads the engine, and an unchanged switch leaves the plugin file alone', async (t) => {
  const engine = fakeEngineContext();
  const { mittr, dataDir } = await setUp(t, { engine, host: desktopHost(), toolDrivers: TOOL_DRIVERS });
  await mittr.tools.applySwitches({ chrome: false });
  assert.deepEqual(engine.restarts, []);

  const file = path.join(toolsDirOf(dataDir), 'index.js');
  const past = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(file, past, past);
  await mittr.tools.applySwitches({ chrome: false, computer: true });

  assert.equal(fs.statSync(file).mtimeMs, past.getTime(), 'the plugin file was written again');
  assert.deepEqual(engine.restarts, []);
});

test('an account switch closes every agent Chrome', async (t) => {
  const driver = stubAgentBrowser(t);
  const fetchImpl = platform({ sessions: [session, sessionB] });
  const { call } = await setUp(t, { fetchImpl, host: desktopHost(), toolDrivers: { ...TOOL_DRIVERS, chrome: () => driver.file } });
  assert.equal((await signIn(call)).status, 200);
  assert.equal((await signIn(call)).status, 200);
  const before = driver.commands().length;

  assert.equal((await call('POST', '/api/mittr/auth/accounts/activate', { userId: 'u-a' })).status, 200);

  await until(() => driver.commands().slice(before).some(({ command }) => command.join(' ') === 'close --all'));
});

const MITTR_DICTATION = { sttProvider: 'openai-compatible', sttServerUrl: 'http://127.0.0.1:4100/mittr-speech/v1' };
const voiceKeysOf = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'voice-keys.json'), 'utf8'));

test('on this Mac the speech endpoint is offered and this run\'s key replaces the last run\'s, never reaching the engine', async (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(path.join(dataDir, 'voice-keys.json'), JSON.stringify({ stt: `mc_speech_${'0'.repeat(64)}`, openai: 'sk-person-own' }), { mode: 0o600 });
  const engine = fakeEngineContext();
  engine.upstreamSettings = MITTR_DICTATION;
  const { mittr, call } = await setUp(t, { dataDir, engine, host: { secretStore: sealingStore() } });
  const key = mittr.speech.keys.current();
  await until(() => voiceKeysOf(dataDir).stt === key);
  assert.equal(voiceKeysOf(dataDir).openai, 'sk-person-own');
  assert.deepEqual((await call('GET', '/api/mittr/speech')).body, {
    offered: true, baseUrl: 'http://127.0.0.1:4100/mittr-speech/v1', model: 'mittr', voice: 'mittr', installed: { stt: true, openaiCompatible: false }, carryDictation: false,
  });
  assert.equal(JSON.stringify(mittr.engineEnv()).includes(key), false);
  const refused = await fetch(`${call.base}/mittr-speech/v1/audio/speech`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${shimKeys.get(dataDir)}` }, body: JSON.stringify({ input: 'hi' }) });
  assert.equal(refused.status, 401);
});

test('a hosted runtime offers no Mittr speech and leaves the voice keys alone', async (t) => {
  const dataDir = tempDataDir(t);
  const before = JSON.stringify({ stt: `mc_speech_${'0'.repeat(64)}` });
  fs.writeFileSync(path.join(dataDir, 'voice-keys.json'), before, { mode: 0o600 });
  const { call } = await setUp(t, { dataDir });
  assert.equal((await call('GET', '/api/mittr/speech')).body.offered, false);
  const answer = await fetch(`${call.base}/mittr-speech/v1/audio/speech`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'hi' }) });
  assert.equal(answer.status, 404);
  assert.equal((await call('GET', '/api/mittr/voice/readiness')).body.here, false);
  assert.equal(fs.readFileSync(path.join(dataDir, 'voice-keys.json'), 'utf8'), before);
});

test('an account switch clears the speech quota blocks', async (t) => {
  const fetchImpl = platform({ sessions: [session, sessionB] });
  const { mittr, call } = await setUp(t, { fetchImpl, host: { secretStore: sealingStore() } });
  assert.equal((await signIn(call)).status, 200);
  assert.equal((await signIn(call)).status, 200);
  mittr.speech.state.block('stt', null);
  mittr.speech.state.block('tts', null);
  assert.equal((await call('POST', '/api/mittr/auth/accounts/activate', { userId: 'u-a' })).status, 200);
  assert.deepEqual(mittr.speech.state.view().stt, { blockedUntil: null });
  assert.deepEqual(mittr.speech.state.view().tts, { blockedUntil: null });
});

test('a hosted runtime registers no voice route', async (t) => {
  const { call } = await setUp(t);
  for (const route of ['/api/mittr/voice/start', '/api/mittr/voice/turn', '/api/mittr/voice/end']) {
    const answer = await fetch(`${call.base}${route}`, { method: 'POST' });
    assert.equal(answer.status, 404, route);
  }
  assert.equal((await fetch(`${call.base}/api/mittr/voice/settings`)).status, 404);
});

test('on this Mac the voice settings are served and a change is stored', async (t) => {
  const { call } = await setUp(t, { host: { secretStore: sealingStore() } });
  const changed = await call('PUT', '/api/mittr/voice/settings', { stepCap: 7 });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.stepCap, 7);
  assert.equal(changed.body.canChange, true);
  const read = await call('GET', '/api/mittr/voice/settings');
  assert.equal(read.status, 200);
  assert.equal(read.body.stepCap, 7);
  assert.equal(typeof read.body.replyMaxChars, 'number');
});

test('a second Talk start, an end and an account switch each end the conversation and its Chrome allow', async (t) => {
  const fetchImpl = platform({ sessions: [session, sessionB] });
  const { mittr, call } = await setUp(t, { fetchImpl, host: { secretStore: sealingStore() } });
  const allowed = () => mittr.tools.chrome.isHostAllowed('voice', 'other.example.test');
  const start = async () => (await call('POST', '/api/mittr/voice/start')).body.conversationId;

  const first = await start();
  assert.ok(first);
  mittr.tools.chrome.allowForConversation('voice');
  assert.equal(await allowed(), true);
  const second = await start();
  assert.notEqual(second, first);
  assert.equal(await allowed(), false);

  mittr.tools.chrome.allowForConversation('voice');
  const ended = await fetch(`${call.base}/api/mittr/voice/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: second }) });
  assert.equal(ended.status, 204);
  assert.equal(await allowed(), false);
  assert.equal(mittr.voice.conversation.current(), null);

  assert.equal((await signIn(call)).status, 200);
  assert.equal((await signIn(call)).status, 200);
  await start();
  mittr.tools.chrome.allowForConversation('voice');
  assert.equal((await call('POST', '/api/mittr/auth/accounts/activate', { userId: 'u-a' })).status, 200);
  assert.equal(mittr.voice.conversation.current(), null);
  assert.equal(await allowed(), false);
});

test('the voice-only actions are registered on this Mac and reach no agent tool', async (t) => {
  const { mittr } = await setUp(t, { host: { secretStore: sealingStore() } });
  const voiceOnly = mittr.registry.definitions({ includeVoiceOnly: true }).filter((entry) => entry.voiceOnly).map(({ action }) => action);
  assert.deepEqual(voiceOnly, ['session.stop', 'session.read_reply', 'chrome.allow_site']);
  assert.equal(mittr.registry.tools().some((tool) => tool.name === 'mittrcraft_voice'), false);
});

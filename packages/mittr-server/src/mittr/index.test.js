import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { setupMittr } from './index.js';
import { fakeFetch, json, serve, tempDataDir } from './test-helpers.js';

const NOW = Date.now();
const DEV_ENV = { MITTRCRAFT_BROKER_URL: 'https://api-dev.mittr.asia', MITTRCRAFT_DEEP_LINK_SCHEME: 'mittrcraft-dev' };

const session = { accessToken: 'at-1', refreshToken: 'r1', expiresAt: NOW + 3_600_000, subject: { userId: 'u-a', displayName: 'A' } };

const sealingStore = () => ({
  encrypt: (text) => Buffer.from(Buffer.from(text, 'utf8').toString('base64'), 'utf8').reverse(),
  decrypt: (data) => Buffer.from(Buffer.from(data).reverse().toString('utf8'), 'base64').toString('utf8'),
});

const recordingLogger = () => {
  const warnings = [];
  return { warnings, log: () => {}, warn: (...args) => warnings.push(args.join(' ')), error: () => {} };
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

const setUp = async (t, { host = null, env = DEV_ENV, fetchImpl = fakeFetch(() => json(session)) } = {}) => {
  const dataDir = tempDataDir(t);
  const app = express();
  const logger = recordingLogger();
  const mittr = setupMittr({ app, express, dataDir, logger, host }, { env, fetchImpl });
  return { mittr, dataDir, logger, fetchImpl, call: await serve(t, app) };
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
  assert.deepEqual(fetchImpl.calls.map((entry) => entry.body.code), ['c1']);
  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: true, userId: 'u-a', displayName: 'A' });

  await assert.rejects(deepLinks.registrations[0].handle({ type: 'auth', raw: 'mittrcraft-dev://auth/callback?code=c2' }), /No sign-in is in progress/);
  await mittr.dispose();
  assert.equal(deepLinks.unregistered(), 1);
});

test('a desktop without a keychain refuses sign-in and leaves the stored tokens alone', async (t) => {
  const deepLinks = deepLinkHost();
  const dataDir = tempDataDir(t);
  const sealed = sealingStore();
  const keyed = express();
  setupMittr({ app: keyed, express, dataDir, logger: recordingLogger(), host: { secretStore: sealed, deepLinks } }, { env: DEV_ENV, fetchImpl: fakeFetch(() => json(session)) });
  assert.equal((await signIn(await serve(t, keyed))).status, 200);
  const snapshot = () => fs.readdirSync(path.join(dataDir, 'mittr-accounts')).map((name) => [name, fs.readFileSync(path.join(dataDir, 'mittr-accounts', name), 'utf8')]);
  const before = snapshot();

  const app = express();
  const logger = recordingLogger();
  const fetchImpl = fakeFetch(() => json(session));
  setupMittr({ app, express, dataDir, logger, host: { secretStore: null, deepLinks: deepLinkHost() } }, { env: DEV_ENV, fetchImpl });
  const call = await serve(t, app);

  const refusal = { status: 503, body: { error: 'This Mac has no keychain available for MittrCraft to store your sign-in safely' } };
  assert.deepEqual(await call('POST', '/api/mittr/auth/start'), refusal);
  assert.deepEqual(await call('POST', '/api/mittr/auth/callback', { url: 'mittrcraft-dev://auth/callback?code=c1' }), refusal);
  assert.deepEqual(await call('DELETE', '/api/mittr/auth/session'), refusal);
  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: false });
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

test('setup hands the server plugin an engine env, a config fragment and a bounded dispose', async (t) => {
  const { mittr } = await setUp(t);
  assert.deepEqual(await mittr.engineEnv(), {});
  assert.deepEqual(await mittr.managedConfig(), {});
  await mittr.dispose();
});

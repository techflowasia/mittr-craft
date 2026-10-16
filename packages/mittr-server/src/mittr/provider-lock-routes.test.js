import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createMittrSettings } from './mittr-settings.js';
import { PROVIDER_LOCK_CHANGED_EVENT, registerProviderLockRoutes } from './provider-lock-routes.js';
import { serve, tempDataDir } from './test-helpers.js';

const recordingLogger = () => {
  const warnings = [];
  return { warnings, log: () => {}, warn: (...args) => warnings.push(args.join(' ')) };
};

const setUp = async (t, { refresh = async () => ({ updated: true }), dataDir = tempDataDir(t) } = {}) => {
  const app = express();
  const logger = recordingLogger();
  const mittrSettings = createMittrSettings({ dataDir, logger });
  const refreshes = [];
  const broadcasts = [];
  registerProviderLockRoutes(app, {
    express,
    mittrSettings,
    managedConfig: {
      refresh: async () => {
        refreshes.push(await mittrSettings.read());
        return refresh();
      },
    },
    events: { broadcast: (type, payload) => broadcasts.push({ type, payload }) },
    logger,
  });
  return { dataDir, logger, refreshes, broadcasts, call: await serve(t, app) };
};

const settingsFile = (dataDir) => path.join(dataDir, 'mittr-settings.json');

const rawCall = (call, method, route, { body, contentType = 'application/json' } = {}) =>
  fetch(call.base + route, { method, headers: { 'content-type': contentType }, body });

test('GET answers the switch, OFF when nothing is stored', async (t) => {
  const { call, dataDir } = await setUp(t);
  assert.deepEqual(await call('GET', '/api/mittr/provider-lock'), { status: 200, body: { showOtherProviders: false } });
  fs.writeFileSync(settingsFile(dataDir), JSON.stringify({ showOtherProviders: true }));
  assert.deepEqual((await call('GET', '/api/mittr/provider-lock')).body, { showOtherProviders: true });
});

test('PUT stores the switch in mittr-settings.json and refreshes the managed config', async (t) => {
  const { call, dataDir, refreshes, broadcasts } = await setUp(t);

  assert.deepEqual(await call('PUT', '/api/mittr/provider-lock', { showOtherProviders: true }), { status: 200, body: { showOtherProviders: true } });

  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile(dataDir), 'utf8')), { showOtherProviders: true });
  assert.equal(fs.statSync(settingsFile(dataDir)).mode & 0o777, 0o600);
  assert.deepEqual(await createMittrSettings({ dataDir, logger: recordingLogger() }).read(), { showOtherProviders: true });
  assert.deepEqual(refreshes, [{ showOtherProviders: true }], 'the refresh renders the stored value');
  assert.deepEqual(broadcasts, [{ type: PROVIDER_LOCK_CHANGED_EVENT, payload: { showOtherProviders: true } }]);
  assert.equal(PROVIDER_LOCK_CHANGED_EVENT, 'mittr.provider-lock.changed');
});

test('PUT refuses anything but an explicit true or false, and changes nothing', async (t) => {
  const { call, dataDir, refreshes, broadcasts } = await setUp(t);
  for (const body of [{}, { showOtherProviders: 'true' }, { showOtherProviders: 1 }, { showOtherProviders: null }, [true]]) {
    const answer = await call('PUT', '/api/mittr/provider-lock', body);
    assert.deepEqual(answer, { status: 400, body: { error: 'showOtherProviders must be true or false' } }, JSON.stringify(body));
  }
  const malformed = await rawCall(call, 'PUT', '/api/mittr/provider-lock', { body: '{' });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'Invalid request body' });
  const oversized = await rawCall(call, 'PUT', '/api/mittr/provider-lock', { body: JSON.stringify({ showOtherProviders: true, pad: 'x'.repeat(2048) }) });
  assert.equal(oversized.status, 413);

  assert.equal(fs.existsSync(settingsFile(dataDir)), false);
  assert.deepEqual(refreshes, []);
  assert.deepEqual(broadcasts, []);
});

test('a refresh that fails keeps the stored switch, says the engine has not taken it up, and still announces the change', async (t) => {
  const { call, logger, broadcasts } = await setUp(t, { refresh: async () => { throw new Error('disk full'); } });

  const answer = await call('PUT', '/api/mittr/provider-lock', { showOtherProviders: true });

  assert.equal(answer.status, 500);
  assert.equal(answer.body.showOtherProviders, true);
  assert.match(answer.body.error, /not taken it up/);
  assert.deepEqual((await call('GET', '/api/mittr/provider-lock')).body, { showOtherProviders: true });
  assert.deepEqual(broadcasts.map((entry) => entry.type), [PROVIDER_LOCK_CHANGED_EVENT]);
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /disk full/);
});

test('a switch that cannot be stored answers 500, refreshes nothing and announces nothing', async (t) => {
  const dataDir = tempDataDir(t);
  fs.mkdirSync(settingsFile(dataDir));
  const { call, refreshes, broadcasts, logger } = await setUp(t, { dataDir });

  const answer = await call('PUT', '/api/mittr/provider-lock', { showOtherProviders: true });

  assert.equal(answer.status, 500);
  assert.equal(answer.body.showOtherProviders, undefined);
  assert.deepEqual(refreshes, []);
  assert.deepEqual(broadcasts, []);
  assert.ok(logger.warnings.some((line) => line.includes('could not store')), logger.warnings.join('\n'));
});

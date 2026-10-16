import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createMittrSettings } from './mittr-settings.js';
import { tempDataDir } from './test-helpers.js';

const recordingLogger = () => {
  const warnings = [];
  return { warnings, log: () => {}, warn: (...args) => warnings.push(args.join(' ')) };
};

const settingsFile = (dataDir) => path.join(dataDir, 'mittr-settings.json');

test('missing settings read as switch OFF, with no warning', async (t) => {
  const dataDir = tempDataDir(t);
  const logger = recordingLogger();
  assert.deepEqual(await createMittrSettings({ dataDir, logger }).read(), { showOtherProviders: false });
  assert.deepEqual(logger.warnings, []);
});

test('the stored switch is honoured', async (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(settingsFile(dataDir), JSON.stringify({ showOtherProviders: true }));
  assert.deepEqual(await createMittrSettings({ dataDir, logger: recordingLogger() }).read(), { showOtherProviders: true });
});

test('corrupt settings read as switch OFF, with one warning naming the file', async (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(settingsFile(dataDir), '{');
  const logger = recordingLogger();
  const settings = createMittrSettings({ dataDir, logger });
  assert.deepEqual(await settings.read(), { showOtherProviders: false });
  assert.deepEqual(await settings.read(), { showOtherProviders: false });
  assert.equal(logger.warnings.length, 1);
  assert.ok(logger.warnings[0].includes(settingsFile(dataDir)), logger.warnings[0]);
});

test('a value that is not exactly true reads as switch OFF', async (t) => {
  const dataDir = tempDataDir(t);
  for (const stored of [{ showOtherProviders: 'true' }, { showOtherProviders: 1 }, [], null, 'yes']) {
    fs.writeFileSync(settingsFile(dataDir), JSON.stringify(stored));
    assert.deepEqual(await createMittrSettings({ dataDir, logger: recordingLogger() }).read(), { showOtherProviders: false }, JSON.stringify(stored));
  }
});

test('settings that cannot be read fail closed', async (t) => {
  const dataDir = tempDataDir(t);
  fs.mkdirSync(settingsFile(dataDir));
  const logger = recordingLogger();
  assert.deepEqual(await createMittrSettings({ dataDir, logger }).read(), { showOtherProviders: false });
  assert.equal(logger.warnings.length, 1);
});

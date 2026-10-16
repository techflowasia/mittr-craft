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

const modeOf = (file) => fs.statSync(file).mode & 0o777;

test('update stores the switch in a private file that a new store reads back', async (t) => {
  const dataDir = tempDataDir(t);
  const settings = createMittrSettings({ dataDir, logger: recordingLogger() });
  assert.deepEqual(await settings.update({ showOtherProviders: true }), { showOtherProviders: true });

  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile(dataDir), 'utf8')), { showOtherProviders: true });
  assert.equal(modeOf(settingsFile(dataDir)), 0o600);
  assert.deepEqual(await createMittrSettings({ dataDir, logger: recordingLogger() }).read(), { showOtherProviders: true });
  assert.deepEqual(fs.readdirSync(dataDir), ['mittr-settings.json'], 'no temp file is left behind');

  assert.deepEqual(await settings.update({ showOtherProviders: false }), { showOtherProviders: false });
  assert.deepEqual(await settings.read(), { showOtherProviders: false });
  assert.equal(modeOf(settingsFile(dataDir)), 0o600);
});

test('an existing file with looser permissions becomes private on the next update', async (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(settingsFile(dataDir), JSON.stringify({ showOtherProviders: true }), { mode: 0o644 });
  await createMittrSettings({ dataDir, logger: recordingLogger() }).update({ showOtherProviders: false });
  assert.equal(modeOf(settingsFile(dataDir)), 0o600);
});

test('updates run one at a time, so the last one asked for is the one stored', async (t) => {
  const dataDir = tempDataDir(t);
  const settings = createMittrSettings({ dataDir, logger: recordingLogger() });
  const results = await Promise.all([true, false, true, false].map((value) => settings.update({ showOtherProviders: value })));
  assert.deepEqual(results.map((result) => result.showOtherProviders), [true, false, true, false]);
  assert.deepEqual(await settings.read(), { showOtherProviders: false });
});

test('an update over a corrupt file replaces it', async (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(settingsFile(dataDir), '{');
  const settings = createMittrSettings({ dataDir, logger: recordingLogger() });
  await settings.update({ showOtherProviders: true });
  assert.deepEqual(await settings.read(), { showOtherProviders: true });
});

test('update takes only an explicit true or false, and a refused one writes nothing', async (t) => {
  const dataDir = tempDataDir(t);
  const settings = createMittrSettings({ dataDir, logger: recordingLogger() });
  for (const patch of [{}, { showOtherProviders: 'true' }, { showOtherProviders: 1 }, null]) {
    await assert.rejects(settings.update(patch), /showOtherProviders/, JSON.stringify(patch));
  }
  assert.equal(fs.existsSync(settingsFile(dataDir)), false);
  assert.deepEqual(await settings.update({ showOtherProviders: true }), { showOtherProviders: true });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { UPSTREAM_SETTINGS_KEYS, migrateSettingsOnce } from './settings.js';

const UPSTREAM_KEYS = new Set(['themeId', 'projects', 'desktopLocalPort', 'openchamberWidgetMode', 'OpenChamberBanner']);

const withDataDir = (t, settings) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-settings-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  if (settings !== undefined) fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2));
  return dataDir;
};

const withRawSettings = (t, raw) => {
  const dataDir = withDataDir(t);
  fs.writeFileSync(path.join(dataDir, 'settings.json'), raw);
  return dataDir;
};

const readSettings = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));

test('migrateSettingsOnce renames known keys, parks unknown ones under mittr, resets dev port 57123, and runs once', async (t) => {
  const dataDir = withDataDir(t, {
    themeId: 'mittr-light',
    projects: [{ id: 'p1', path: '/work/p1' }],
    desktopLocalPort: 57123,
    mittrcraftWidgetMode: 'compact',
    MittrCraftBanner: false,
    mittrcraftOnlyOurs: 1,
    agentChromeToolEnabled: true,
    typographySizes: { body: 14 },
  });

  const first = await migrateSettingsOnce({ dataDir, flavor: 'dev', upstreamKeys: UPSTREAM_KEYS });

  assert.deepEqual(first.renamed, ['mittrcraftWidgetMode', 'MittrCraftBanner']);
  assert.deepEqual(first.moved, ['mittrcraftOnlyOurs', 'agentChromeToolEnabled', 'typographySizes']);
  assert.deepEqual(readSettings(dataDir), {
    themeId: 'mittr-light',
    projects: [{ id: 'p1', path: '/work/p1' }],
    desktopLocalPort: 57133,
    openchamberWidgetMode: 'compact',
    OpenChamberBanner: false,
    mittr: {
      mittrcraftOnlyOurs: 1,
      agentChromeToolEnabled: true,
      typographySizes: { body: 14 },
    },
  });

  fs.writeFileSync(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({ desktopLocalPort: 57123, newMittrKey: true }),
  );
  const second = await migrateSettingsOnce({ dataDir, flavor: 'dev', upstreamKeys: UPSTREAM_KEYS });

  assert.deepEqual(second, { renamed: [], moved: [], portReset: false });
  assert.deepEqual(readSettings(dataDir), { desktopLocalPort: 57123, newMittrKey: true });
});

test('migrateSettingsOnce keeps a prod port and any other dev port', async (t) => {
  const prod = withDataDir(t, { desktopLocalPort: 57123 });
  await migrateSettingsOnce({ dataDir: prod, flavor: 'prod', upstreamKeys: UPSTREAM_KEYS });
  assert.equal(readSettings(prod).desktopLocalPort, 57123);

  const dev = withDataDir(t, { desktopLocalPort: 60000 });
  await migrateSettingsOnce({ dataDir: dev, flavor: 'dev', upstreamKeys: UPSTREAM_KEYS });
  assert.equal(readSettings(dev).desktopLocalPort, 60000);
});

test('migrateSettingsOnce lets the renamed 1.x value win over the upstream name', async (t) => {
  for (const settings of [
    { openchamberWidgetMode: 'upstream', mittrcraftWidgetMode: 'ours' },
    { mittrcraftWidgetMode: 'ours', openchamberWidgetMode: 'upstream' },
  ]) {
    const dataDir = withDataDir(t, settings);
    await migrateSettingsOnce({ dataDir, flavor: 'prod', upstreamKeys: UPSTREAM_KEYS });
    assert.deepEqual(readSettings(dataDir), { openchamberWidgetMode: 'ours' });
  }
});

test('migrateSettingsOnce adds to an existing mittr section', async (t) => {
  const dataDir = withDataDir(t, { mittr: { kept: 'yes' }, voiceStepCap: 4 });
  await migrateSettingsOnce({ dataDir, flavor: 'prod', upstreamKeys: UPSTREAM_KEYS });
  assert.deepEqual(readSettings(dataDir), { mittr: { kept: 'yes', voiceStepCap: 4 } });
});

test('migrateSettingsOnce marks a data dir without settings as done', async (t) => {
  const dataDir = withDataDir(t);
  assert.deepEqual(
    await migrateSettingsOnce({ dataDir, flavor: 'dev', upstreamKeys: UPSTREAM_KEYS }),
    { renamed: [], moved: [], portReset: false },
  );
  assert.equal(fs.existsSync(path.join(dataDir, 'settings.json')), false);

  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ voiceStepCap: 4 }));
  await migrateSettingsOnce({ dataDir, flavor: 'dev', upstreamKeys: UPSTREAM_KEYS });
  assert.deepEqual(readSettings(dataDir), { voiceStepCap: 4 });
});

test('migrateSettingsOnce rejects an unreadable settings file, leaves it as it is and retries later', async (t) => {
  for (const raw of ['{"themeId": ', '[1, 2]', 'null']) {
    const dataDir = withRawSettings(t, raw);
    await assert.rejects(migrateSettingsOnce({ dataDir, flavor: 'dev', upstreamKeys: UPSTREAM_KEYS }));
    assert.equal(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'), raw);

    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ voiceStepCap: 4 }));
    await migrateSettingsOnce({ dataDir, flavor: 'dev', upstreamKeys: UPSTREAM_KEYS });
    assert.deepEqual(readSettings(dataDir), { mittr: { voiceStepCap: 4 } });
  }
});

test('UPSTREAM_SETTINGS_KEYS knows the registry and the keys upstream reads outside it', () => {
  for (const key of [
    'themeId',
    'projects',
    'desktopLocalPort',
    'desktopInstallId',
    'desktopLocalClientToken',
    'desktopInitialHostChoiceCompleted',
    'themeMode',
    'collapsedProjects',
    'namedTunnelToken',
  ]) {
    assert.equal(UPSTREAM_SETTINGS_KEYS.has(key), true, key);
  }
  assert.equal(UPSTREAM_SETTINGS_KEYS.has('mittr'), false);
  assert.equal(UPSTREAM_SETTINGS_KEYS.has('agentChromeToolEnabled'), false);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import registry from '../../web/server/lib/opencode/settings-registry.json' with { type: 'json' };
import { MITTR_SETTINGS_KEYS, UPSTREAM_SETTINGS_KEYS, migrateSettingsOnce } from './settings.js';
import { repoRoot } from './upstream-contract.js';

const UPSTREAM_KEYS = new Set(['themeId', 'projects', 'desktopLocalPort', 'openchamberWidgetMode', 'OpenChamberBanner']);
const MITTR_KEYS = new Set(['agentChromeToolEnabled', 'voiceStepCap']);
const keys = { upstreamKeys: UPSTREAM_KEYS, mittrKeys: MITTR_KEYS };
const realKeys = { upstreamKeys: UPSTREAM_SETTINGS_KEYS, mittrKeys: MITTR_SETTINGS_KEYS };

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

test('migrateSettingsOnce renames known keys, moves only listed Mittr keys under mittr, and runs once', async (t) => {
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

  const first = await migrateSettingsOnce({ dataDir, ...keys });

  assert.deepEqual(first.renamed, ['mittrcraftWidgetMode', 'MittrCraftBanner']);
  assert.deepEqual(first.moved, ['agentChromeToolEnabled']);
  assert.deepEqual(readSettings(dataDir), {
    themeId: 'mittr-light',
    projects: [{ id: 'p1', path: '/work/p1' }],
    desktopLocalPort: 57123,
    mittrcraftOnlyOurs: 1,
    typographySizes: { body: 14 },
    openchamberWidgetMode: 'compact',
    OpenChamberBanner: false,
    mittr: { agentChromeToolEnabled: true },
  });

  fs.writeFileSync(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({ desktopLocalPort: 57123, voiceStepCap: 4, mittrcraftWidgetMode: 'x' }),
  );
  const second = await migrateSettingsOnce({ dataDir, ...keys });

  assert.deepEqual(second, { renamed: [], moved: [] });
  assert.deepEqual(readSettings(dataDir), { desktopLocalPort: 57123, voiceStepCap: 4, mittrcraftWidgetMode: 'x' });
});

test('migrateSettingsOnce keeps every key upstream reads at the top level', async (t) => {
  const upstreamRead = {
    relaySigningKey: { publicJwk: { kty: 'OKP' }, privateJwk: { kty: 'OKP', d: 'x' } },
    relayEncryptionKey: { publicJwk: { kty: 'OKP' }, privateJwk: { kty: 'OKP', d: 'y' } },
    vapidKeys: { publicKey: 'pub', privateKey: 'priv' },
    publicOrigin: 'https://example.test',
    apnsConfig: { keyId: 'k', teamId: 't', bundleId: 'b' },
    splashBgLight: '#ffffff',
    splashFgLight: '#000000',
    splashBgDark: '#000000',
    splashFgDark: '#ffffff',
    desktopLocalClientToken: 'token',
    themeMode: 'dark',
    permissionAutoAccept: { sessions: { s1: 'auto' } },
  };
  for (const key of Object.keys(upstreamRead)) assert.equal(UPSTREAM_SETTINGS_KEYS.has(key), true, key);

  const dataDir = withDataDir(t, { ...upstreamRead, agentChromeProfile: 'Work' });
  const result = await migrateSettingsOnce({ dataDir, ...realKeys });

  assert.deepEqual(result, { renamed: [], moved: ['agentChromeProfile'] });
  assert.deepEqual(readSettings(dataDir), { ...upstreamRead, mittr: { agentChromeProfile: 'Work' } });
});

test('migrateSettingsOnce leaves keys that are neither upstream nor listed Mittr keys where they are', async (t) => {
  const settings = { typographySizes: { markdown: '14px' }, gitModelId: 'm', someFutureKey: [1] };
  const dataDir = withDataDir(t, settings);
  const raw = fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8');

  assert.deepEqual(await migrateSettingsOnce({ dataDir, ...realKeys }), { renamed: [], moved: [] });
  assert.equal(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'), raw);
  assert.equal(fs.existsSync(path.join(dataDir, '.pre-2x-settings-done')), true);
});

test('migrateSettingsOnce moves every listed 1.22 Mittr key', async (t) => {
  const settings = Object.fromEntries([...MITTR_SETTINGS_KEYS].map((key, index) => [key, index]));
  const dataDir = withDataDir(t, { ...settings, themeId: 'x' });
  const result = await migrateSettingsOnce({ dataDir, ...realKeys });

  assert.deepEqual(result.moved.sort(), [...MITTR_SETTINGS_KEYS].sort());
  assert.deepEqual(readSettings(dataDir), { themeId: 'x', mittr: settings });
});

test('migrateSettingsOnce leaves the saved desktop port alone', async (t) => {
  const dataDir = withDataDir(t, { desktopLocalPort: 57123, voiceStepCap: 4 });
  await migrateSettingsOnce({ dataDir, ...keys });
  assert.deepEqual(readSettings(dataDir), { desktopLocalPort: 57123, mittr: { voiceStepCap: 4 } });
});

test('migrateSettingsOnce lets the renamed 1.x value win and parks the upstream-name value under mittr', async (t) => {
  for (const settings of [
    { openchamberWidgetMode: 'upstream', mittrcraftWidgetMode: 'ours' },
    { mittrcraftWidgetMode: 'ours', openchamberWidgetMode: 'upstream' },
  ]) {
    const dataDir = withDataDir(t, settings);
    const result = await migrateSettingsOnce({ dataDir, ...keys });
    assert.deepEqual(result, { renamed: ['mittrcraftWidgetMode'], moved: ['openchamberWidgetMode'] });
    assert.deepEqual(readSettings(dataDir), {
      openchamberWidgetMode: 'ours',
      mittr: { openchamberWidgetMode: 'upstream' },
    });
  }
});

test('migrateSettingsOnce adds to an existing mittr section', async (t) => {
  const dataDir = withDataDir(t, { mittr: { kept: 'yes' }, voiceStepCap: 4 });
  await migrateSettingsOnce({ dataDir, ...keys });
  assert.deepEqual(readSettings(dataDir), { mittr: { kept: 'yes', voiceStepCap: 4 } });
});

test('migrateSettingsOnce marks a data dir without settings as done', async (t) => {
  const dataDir = withDataDir(t);
  assert.deepEqual(await migrateSettingsOnce({ dataDir, ...keys }), { renamed: [], moved: [] });
  assert.equal(fs.existsSync(path.join(dataDir, 'settings.json')), false);

  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ voiceStepCap: 4 }));
  await migrateSettingsOnce({ dataDir, ...keys });
  assert.deepEqual(readSettings(dataDir), { voiceStepCap: 4 });
});

test('migrateSettingsOnce rejects an unreadable settings file, leaves it as it is and retries later', async (t) => {
  for (const raw of ['{"themeId": ', '[1, 2]', 'null']) {
    const dataDir = withRawSettings(t, raw);
    await assert.rejects(migrateSettingsOnce({ dataDir, ...keys }));
    assert.equal(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'), raw);

    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ voiceStepCap: 4 }));
    await migrateSettingsOnce({ dataDir, ...keys });
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
  for (const key of MITTR_SETTINGS_KEYS) assert.equal(UPSTREAM_SETTINGS_KEYS.has(key), false, key);
});

// Upstream reading one of our keys means it must stay at the top level: take
// it off the Mittr list and decide what the 1.22 value means to upstream.
test('upstream source never mentions a listed Mittr settings key', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  for (const key of MITTR_SETTINGS_KEYS) {
    const result = spawnSync(
      'git',
      ['-C', repoRoot, 'grep', '-l', '-w', key, '--', 'packages/web', 'packages/electron', 'packages/ui', 'packages/vscode', ':!*.md'],
      { encoding: 'utf8', env },
    );
    assert.equal(result.status, 1, `${key} is now in upstream: ${result.stdout}`);
  }
});

// A renamed key never needs renaming in preferences.json as well: upstream
// seeds that file only with profile-scope registry keys, and none of them has
// an OpenChamber spelling a 1.x key could be renamed to.
test('no profile-scope registry key has an OpenChamber spelling', () => {
  const profileKeys = Object.entries(registry.fields)
    .filter(([, field]) => field.scope === 'profile')
    .map(([key]) => key);
  assert.ok(profileKeys.length > 0);
  assert.deepEqual(profileKeys.filter((key) => /openchamber/i.test(key)), []);
});

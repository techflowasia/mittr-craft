import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepareCliEnvironment, readProductEnv } from './cli-env.js';
import { repoRoot } from './upstream-contract.js';

const BIN = path.join(repoRoot, 'packages/mittr-server/bin/mittrcraft.mjs');
const SERVER_CLI = path.join(repoRoot, 'packages/web/bin/cli.js');
const PLUGIN = path.join(repoRoot, 'packages/mittr-server/src/plugin.js');
const PRODUCT_ENV = readProductEnv(path.join(repoRoot, 'brand/product.prod.json'));

const runIsolated = (t, entry, args, extraEnv = {}) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittrcraft-bin-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCHAMBER_|OPENCODE_|XDG_|MITTR)/.test(name)));
  const result = spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8',
    cwd: home,
    timeout: 60_000,
    env: {
      ...inherited,
      HOME: home,
      USERPROFILE: home,
      OPENCHAMBER_DATA_DIR: path.join(home, 'data'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      XDG_STATE_HOME: path.join(home, '.local', 'state'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      NO_COLOR: '1',
      ...extraEnv,
    },
  });
  return { ...result, home };
};

test('the mittrcraft bin forwards to the server CLI', (t) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/mittr-server/package.json'), 'utf8'));
  assert.deepEqual(manifest.bin, { mittrcraft: './bin/mittrcraft.mjs' });
  assert.ok(fs.statSync(BIN).mode & 0o111, 'the bin is not executable');

  const wrapped = runIsolated(t, BIN, ['--help']);
  const direct = runIsolated(t, SERVER_CLI, ['--help']);

  assert.equal(wrapped.status, 0, wrapped.stderr);
  assert.equal(direct.status, 0, direct.stderr);
  assert.ok(wrapped.stdout.includes('openchamber [COMMAND] [OPTIONS]'), wrapped.stdout);
  assert.equal(wrapped.stdout, direct.stdout);
});

test('the mittrcraft bin hands every argument on unchanged', (t) => {
  const wrapped = runIsolated(t, BIN, ['--definitely-not-a-flag']);
  const direct = runIsolated(t, SERVER_CLI, ['--definitely-not-a-flag']);

  assert.notEqual(direct.status, 0);
  assert.equal(wrapped.status, direct.status);
  assert.equal(wrapped.stdout, direct.stdout);
  assert.equal(wrapped.stderr, direct.stderr);
});

const prepare = (env) => prepareCliEnvironment({ env, homeDir: '/home/person', pluginPath: PLUGIN, productEnv: PRODUCT_ENV });

test('the mittrcraft bin loads the Mittr plugin, the MittrCraft data dir and the prod broker unless told otherwise', () => {
  const { env, refusal } = prepare({ PATH: '/bin' });

  assert.equal(refusal, null);
  assert.deepEqual(JSON.parse(env.OPENCHAMBER_SERVER_PLUGINS), [PLUGIN]);
  assert.equal(env.OPENCHAMBER_DATA_DIR, path.join('/home/person', '.config', 'mittrcraft'));
  assert.equal(env.MITTRCRAFT_BROKER_URL, 'https://api.mittr.asia');
  assert.equal(env.MITTRCRAFT_BROKER_FIXED, '1');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.OPENCHAMBER_UI_PASSWORD, undefined);
});

test('the mittrcraft bin keeps what is set and maps the 1.22 names onto unset upstream ones', () => {
  const mapped = prepare({
    MITTRCRAFT_UI_PASSWORD: 'p122',
    MITTRCRAFT_ALLOW_UNAUTHENTICATED_LAN: 'true',
    MITTRCRAFT_DATA_DIR: '/srv/mittr-data',
  }).env;
  assert.equal(mapped.OPENCHAMBER_UI_PASSWORD, 'p122');
  assert.equal(mapped.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN, 'true');
  assert.equal(mapped.OPENCHAMBER_DATA_DIR, '/srv/mittr-data');

  const kept = prepare({
    MITTRCRAFT_UI_PASSWORD: 'p122',
    OPENCHAMBER_UI_PASSWORD: 'p2',
    MITTRCRAFT_DATA_DIR: '/srv/mittr-data',
    OPENCHAMBER_DATA_DIR: '/srv/oc-data',
    MITTRCRAFT_BROKER_URL: 'https://api-dev.mittr.asia',
    OPENCHAMBER_SERVER_PLUGINS: JSON.stringify(['/opt/other.mjs', PLUGIN]),
  }).env;
  assert.equal(kept.OPENCHAMBER_UI_PASSWORD, 'p2');
  assert.equal(kept.OPENCHAMBER_DATA_DIR, '/srv/oc-data');
  assert.equal(kept.MITTRCRAFT_BROKER_URL, 'https://api-dev.mittr.asia');
  assert.deepEqual(JSON.parse(kept.OPENCHAMBER_SERVER_PLUGINS), ['/opt/other.mjs', PLUGIN]);
});

test('company sign-in settings without the Mittr plugin refuse to start', () => {
  for (const plugins of ['[]', JSON.stringify(['/opt/other.mjs']), 'not json', JSON.stringify(['src/plugin.js'])]) {
    const { refusal } = prepare({ MITTR_AD_CLIENT_ID: 'app', OPENCHAMBER_SERVER_PLUGINS: plugins });
    assert.match(refusal, /company sign-in is configured \(MITTR_AD_CLIENT_ID\)/, plugins);
  }
  assert.equal(prepare({ MITTR_AD_CLIENT_ID: 'app' }).refusal, null);
  assert.equal(prepare({ MITTR_AD_ENABLED: 'true', OPENCHAMBER_SERVER_PLUGINS: JSON.stringify([PLUGIN]) }).refusal, null);
  assert.equal(prepare({ MITTR_AD_ENABLED: '', OPENCHAMBER_SERVER_PLUGINS: '[]' }).refusal, null);
});

test('the mittrcraft bin exits before the server CLI when company sign-in would be skipped', (t) => {
  const result = runIsolated(t, BIN, ['serve', '--foreground', '--port', '9'], {
    MITTR_AD_ENABLED: 'true',
    MITTR_AD_BIND_PASSWORD: 'service-account-secret',
    OPENCHAMBER_SERVER_PLUGINS: '[]',
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^mittrcraft: company sign-in is configured \(MITTR_AD_BIND_PASSWORD, MITTR_AD_ENABLED\)/);
  assert.ok(!result.stderr.includes('service-account-secret'));
  assert.deepEqual(fs.readdirSync(result.home), []);
});

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

const tempLayout = (t, prefix) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageDir = path.join(root, 'packages', 'mittr-server');
  fs.mkdirSync(path.join(packageDir, 'src'), { recursive: true });
  return { root, packageDir };
};

test('from a source checkout the bin refuses the default data dir and runs with an explicit one', (t) => {
  const { root, packageDir } = tempLayout(t, 'mittrcraft-checkout-');
  fs.mkdirSync(path.join(root, '.git'));
  const inCheckout = (env) => prepareCliEnvironment({ env, homeDir: '/home/person', pluginPath: PLUGIN, productEnv: PRODUCT_ENV, packageDir });

  const refused = inCheckout({});
  assert.match(refused.refusal, /^mittrcraft: this copy runs from a source checkout \(/);
  assert.ok(refused.refusal.includes(root) && refused.refusal.includes('OPENCHAMBER_DATA_DIR or MITTRCRAFT_DATA_DIR'));
  assert.equal(inCheckout({ OPENCHAMBER_DATA_DIR: '  ' }).refusal.startsWith('mittrcraft: this copy runs from a source checkout'), true);

  const explicit = inCheckout({ OPENCHAMBER_DATA_DIR: '/srv/oc-data' });
  assert.equal(explicit.refusal, null);
  assert.equal(explicit.env.OPENCHAMBER_DATA_DIR, '/srv/oc-data');
  const legacy = inCheckout({ MITTRCRAFT_DATA_DIR: '/srv/mittr-data' });
  assert.equal(legacy.refusal, null);
  assert.equal(legacy.env.OPENCHAMBER_DATA_DIR, '/srv/mittr-data');

  const worktree = tempLayout(t, 'mittrcraft-worktree-');
  fs.writeFileSync(path.join(worktree.root, '.git'), 'gitdir: /elsewhere\n');
  assert.ok(prepareCliEnvironment({ env: {}, homeDir: '/home/person', pluginPath: PLUGIN, productEnv: PRODUCT_ENV, packageDir: worktree.packageDir }).refusal);
});

test('this checkout\'s bin refuses to start without a data dir and touches nothing', (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittrcraft-bin-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCHAMBER_|OPENCODE_|XDG_|MITTR)/.test(name)));
  const result = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8', cwd: home, timeout: 60_000, env: { ...inherited, HOME: home, USERPROFILE: home } });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^mittrcraft: this copy runs from a source checkout/);
  assert.deepEqual(fs.readdirSync(home), []);
});

const packedBin = (t, prefix) => {
  const { root, packageDir } = tempLayout(t, prefix);
  fs.cpSync(path.join(repoRoot, 'packages/mittr-server/bin'), path.join(packageDir, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'packages/mittr-server/src/cli-env.js'), path.join(packageDir, 'src', 'cli-env.js'));
  fs.writeFileSync(path.join(packageDir, 'src', 'plugin.js'), 'export default () => {};\n');
  return { root, packageDir, bin: path.join(packageDir, 'bin', 'mittrcraft.mjs') };
};

test('the env shipped next to the bin is the prod product env', () => {
  assert.deepEqual(readProductEnv(path.join(repoRoot, 'packages/mittr-server/bin/product-env.json')), PRODUCT_ENV);
});

test('a packed bin without brand/ finds its product env and answers --help', (t) => {
  const { root, bin } = packedBin(t, 'mittrcraft-packed-help-');
  fs.symlinkSync(path.join(repoRoot, 'packages/web'), path.join(root, 'packages', 'web'), 'dir');
  assert.equal(fs.existsSync(path.join(root, 'brand')), false);

  const packed = runIsolated(t, bin, ['--help']);
  const direct = runIsolated(t, SERVER_CLI, ['--help']);

  assert.equal(packed.status, 0, packed.stderr);
  assert.ok(packed.stdout.includes('openchamber [COMMAND] [OPTIONS]'), packed.stdout);
  assert.equal(packed.stdout, direct.stdout);
});

test('a packed layout without .git gets the default data dir and the bin touches nothing', (t) => {
  const { root, packageDir } = packedBin(t, 'mittrcraft-packed-');
  fs.mkdirSync(path.join(root, 'packages', 'web', 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'packages', 'web', 'bin', 'cli.js'),
    "console.log(JSON.stringify({ args: process.argv.slice(2), dataDir: process.env.OPENCHAMBER_DATA_DIR, plugins: process.env.OPENCHAMBER_SERVER_PLUGINS, broker: process.env.MITTRCRAFT_BROKER_URL }));\n",
  );
  fs.writeFileSync(path.join(root, 'packages', 'web', 'package.json'), '{"type":"module"}\n');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittrcraft-bin-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCHAMBER_|OPENCODE_|XDG_|MITTR)/.test(name)));

  const result = spawnSync(process.execPath, [path.join(packageDir, 'bin', 'mittrcraft.mjs'), 'serve', '--port', '9'], {
    encoding: 'utf8',
    cwd: home,
    timeout: 60_000,
    env: { ...inherited, HOME: home, USERPROFILE: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    args: ['serve', '--port', '9'],
    dataDir: path.join(home, '.config', 'mittrcraft'),
    plugins: JSON.stringify([path.join(packageDir, 'src', 'plugin.js')]),
    broker: 'https://api.mittr.asia',
  });
  assert.deepEqual(fs.readdirSync(home), []);
});

const PRODUCT_KEYS = Object.keys(PRODUCT_ENV);

const runPackedEnvProbe = (t, extraEnv = {}) => {
  const { root, packageDir } = packedBin(t, 'mittrcraft-packed-env-');
  fs.mkdirSync(path.join(root, 'packages', 'web', 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'packages', 'web', 'bin', 'cli.js'),
    `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(PRODUCT_KEYS)}.map((name) => [name, process.env[name] ?? null]))));\n`,
  );
  fs.writeFileSync(path.join(root, 'packages', 'web', 'package.json'), '{"type":"module"}\n');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittrcraft-bin-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCHAMBER_|OPENCODE_|XDG_|MITTR)/.test(name)));
  const result = spawnSync(process.execPath, [path.join(packageDir, 'bin', 'mittrcraft.mjs'), 'serve'], {
    encoding: 'utf8',
    cwd: home,
    timeout: 60_000,
    env: { ...inherited, HOME: home, USERPROFILE: home, ...extraEnv },
  });
  assert.equal(result.status, 0, result.stderr);
  return { home, seen: JSON.parse(result.stdout) };
};

test('a packed layout run applies the whole prod product env, with ~ as the home', (t) => {
  const { home, seen } = runPackedEnvProbe(t);

  assert.deepEqual(seen, {
    OPENCHAMBER_DATA_DIR: path.join(home, '.config', 'mittrcraft'),
    OPENCODE_CONFIG_DIR: path.join(home, '.config', 'mittrcraft', 'engine', 'opencode'),
    OPENCHAMBER_POLICY_FILE: '/Library/Application Support/MittrCraft/policy.json',
    OPENCHAMBER_MANAGED_PROCESS_REGISTRY: path.join(home, '.config', 'mittrcraft', 'managed-opencode'),
    OPENCHAMBER_UPDATE_CHECK_DISABLED: '1',
    OPENCHAMBER_MODELS_METADATA_DISABLED: '1',
    MITTRCRAFT_ENGINE_HOME: '',
    MITTRCRAFT_DEEP_LINK_SCHEME: 'mittrcraft',
    MITTRCRAFT_BROKER_URL: 'https://api.mittr.asia',
    MITTRCRAFT_BROKER_FIXED: '1',
  });
  assert.deepEqual(fs.readdirSync(home), []);
});

test('every product env value gives way to one set explicitly', (t) => {
  const explicit = Object.fromEntries(PRODUCT_KEYS.map((name) => [name, `/explicit/${name.toLowerCase()}`]));
  assert.deepEqual(runPackedEnvProbe(t, explicit).seen, explicit);
});

test('the npm pack of this package ships the bin with the product env beside it', (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittrcraft-pack-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(npm_|OPENCHAMBER_|OPENCODE_|XDG_|MITTR)/i.test(name)));
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    encoding: 'utf8',
    cwd: path.join(repoRoot, 'packages/mittr-server'),
    timeout: 60_000,
    env: { ...inherited, HOME: home, USERPROFILE: home, npm_config_cache: path.join(home, 'cache'), npm_config_update_notifier: 'false' },
  });
  assert.equal(result.status, 0, result.stderr);
  const packed = JSON.parse(result.stdout)[0].files.map((file) => file.path);
  for (const file of ['bin/mittrcraft.mjs', 'bin/product-env.json', 'src/cli-env.js', 'src/plugin.js']) {
    assert.ok(packed.includes(file), `${file} is not in the pack`);
  }
});

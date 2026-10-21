import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { prepareCliEnvironment, readProductEnv } from './cli-env.js';
import { engineBases, engineConfigDir } from './engine-home.js';
import { repoRoot } from './upstream-contract.js';

const BIN = path.join(repoRoot, 'packages/mittr-server/bin/mittrcraft.mjs');
const SERVER_CLI = path.join(repoRoot, 'packages/web/bin/cli.js');
const PLUGIN = path.join(repoRoot, 'packages/mittr-server/src/plugin.js');
const PRODUCT_ENV = readProductEnv(path.join(repoRoot, 'brand/product.prod.json'));

const RG_STUB_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittrcraft-rg-stub-')));
fs.writeFileSync(path.join(RG_STUB_DIR, 'rg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.on('exit', () => fs.rmSync(RG_STUB_DIR, { recursive: true, force: true }));

const withStubRipgrep = (env) => ({ ...env, PATH: [RG_STUB_DIR, env.PATH].filter(Boolean).join(path.delimiter) });

const runIsolated = (t, entry, args, extraEnv = {}) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittrcraft-bin-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCHAMBER_|OPENCODE_|XDG_|MITTR)/.test(name)));
  const isolatedEnv = {
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
  };
  const result = spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8',
    cwd: home,
    timeout: 60_000,
    env: Object.hasOwn(extraEnv, 'PATH') ? isolatedEnv : withStubRipgrep(isolatedEnv),
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

test('with its own data dir the bin puts the engine, its config and the process registry under it, never the installed app\'s', () => {
  const installed = ['/home/person/.config/mittrcraft', '/home/person/.local', '/home/person/.cache/mittrcraft'];
  for (const env of [{ OPENCHAMBER_DATA_DIR: '/srv/mc-test' }, { MITTRCRAFT_DATA_DIR: '/srv/mc-test' }, { OPENCHAMBER_DATA_DIR: '/srv/mc-test/' }]) {
    const prepared = prepare(env).env;
    assert.equal(prepared.MITTRCRAFT_ENGINE_HOME, '/srv/mc-test/engine');
    assert.equal(prepared.OPENCODE_CONFIG_DIR, '/srv/mc-test/engine/opencode');
    assert.equal(prepared.OPENCHAMBER_MANAGED_PROCESS_REGISTRY, '/srv/mc-test/managed-opencode');
    const bases = engineBases({ homeDir: '/home/person', env: prepared });
    const engine = [...Object.values(bases), engineConfigDir({ bases, env: prepared }), prepared.OPENCHAMBER_MANAGED_PROCESS_REGISTRY];
    for (const where of engine) {
      assert.ok(where.startsWith('/srv/mc-test/'), where);
      assert.ok(!installed.some((root) => where.startsWith(root)), where);
    }
  }
});

test('the default data dir, named or not, keeps the installed layout, and an engine home set by hand carries the engine config', () => {
  for (const env of [{}, { OPENCHAMBER_DATA_DIR: '/home/person/.config/mittrcraft' }, { OPENCHAMBER_DATA_DIR: '~/.config/mittrcraft' }]) {
    const prepared = prepare(env).env;
    assert.equal(prepared.MITTRCRAFT_ENGINE_HOME, '');
    assert.equal(prepared.OPENCODE_CONFIG_DIR, '/home/person/.config/mittrcraft/engine/opencode');
    assert.equal(prepared.OPENCHAMBER_MANAGED_PROCESS_REGISTRY, '/home/person/.config/mittrcraft/managed-opencode');
  }
  const own = prepare({ OPENCHAMBER_DATA_DIR: '/srv/mc-test', MITTRCRAFT_ENGINE_HOME: '/srv/engine', OPENCHAMBER_MANAGED_PROCESS_REGISTRY: '/run/registry' }).env;
  assert.equal(own.MITTRCRAFT_ENGINE_HOME, '/srv/engine');
  assert.equal(own.OPENCODE_CONFIG_DIR, '/srv/engine/opencode');
  assert.equal(own.OPENCHAMBER_MANAGED_PROCESS_REGISTRY, '/run/registry');
  assert.equal(prepare({ MITTRCRAFT_ENGINE_HOME: '/srv/engine' }).env.OPENCODE_CONFIG_DIR, '/srv/engine/opencode');
  assert.equal(prepare({ OPENCHAMBER_DATA_DIR: '/srv/mc-test', OPENCODE_CONFIG_DIR: '/etc/oc' }).env.OPENCODE_CONFIG_DIR, '/etc/oc');
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
    env: withStubRipgrep({ ...inherited, HOME: home, USERPROFILE: home }),
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

const PRODUCT_KEYS = [...Object.keys(PRODUCT_ENV), 'BUN_BINARY'];

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
    env: withStubRipgrep({ ...inherited, HOME: home, USERPROFILE: home, ...extraEnv }),
  });
  assert.equal(result.status, 0, result.stderr);
  return { home, seen: JSON.parse(result.stdout) };
};

test('a packed layout run applies the whole prod product env, with ~ as the home', (t) => {
  const { home, seen } = runPackedEnvProbe(t);

  assert.deepEqual(seen, {
    OPENCHAMBER_DATA_DIR: path.join(home, '.config', 'mittrcraft'),
    OPENCODE_CONFIG_DIR: path.join(home, '.config', 'mittrcraft', 'engine', 'opencode'),
    OPENCHAMBER_POLICY_FILE: process.platform === 'darwin' ? '/Library/Application Support/MittrCraft/policy.json' : null,
    OPENCHAMBER_MANAGED_PROCESS_REGISTRY: path.join(home, '.config', 'mittrcraft', 'managed-opencode'),
    OPENCHAMBER_UPDATE_CHECK_DISABLED: '1',
    OPENCHAMBER_MODELS_METADATA_DISABLED: '1',
    MITTRCRAFT_ENGINE_HOME: '',
    MITTRCRAFT_DEEP_LINK_SCHEME: 'mittrcraft',
    MITTRCRAFT_BROKER_URL: 'https://api.mittr.asia',
    MITTRCRAFT_BROKER_FIXED: '1',
    BUN_BINARY: process.execPath,
  });
  assert.deepEqual(fs.readdirSync(home), []);
});

test('the MittrCraft policy path replaces upstream\'s fixed ones on macOS only, where it is a path', async () => {
  const { policyFilePaths } = await import(pathToFileURL(path.join(repoRoot, 'packages/web/server/lib/enterprise-mode.js')).href);
  const on = (platform, env = {}) => {
    const prepared = prepareCliEnvironment({ env, homeDir: '/home/person', pluginPath: PLUGIN, productEnv: PRODUCT_ENV, platform });
    return { prepared: prepared.env.OPENCHAMBER_POLICY_FILE, paths: policyFilePaths({ platform, env: prepared.env }) };
  };
  assert.deepEqual(on('darwin'), { prepared: '/Library/Application Support/MittrCraft/policy.json', paths: ['/Library/Application Support/MittrCraft/policy.json'] });
  assert.deepEqual(on('linux'), { prepared: undefined, paths: ['/etc/openchamber/policy.json'] });
  assert.deepEqual(on('win32'), { prepared: undefined, paths: ['C:\\ProgramData\\OpenChamber\\policy.json'] });
  assert.deepEqual(on('linux', { OPENCHAMBER_POLICY_FILE: '/etc/mittrcraft/policy.json' }), { prepared: '/etc/mittrcraft/policy.json', paths: ['/etc/mittrcraft/policy.json'] });
});

test('the hosted server runs on the Node that runs the bin unless BUN_BINARY says otherwise', () => {
  const base = { homeDir: '/home/person', pluginPath: PLUGIN, productEnv: PRODUCT_ENV, nodePath: '/opt/node/bin/node' };
  assert.equal(prepareCliEnvironment({ ...base, env: {} }).env.BUN_BINARY, '/opt/node/bin/node');
  assert.equal(prepareCliEnvironment({ ...base, env: { BUN_BINARY: ' ' } }).env.BUN_BINARY, '/opt/node/bin/node');
  assert.equal(prepareCliEnvironment({ ...base, env: { BUN_BINARY: '/opt/bun/bin/bun' } }).env.BUN_BINARY, '/opt/bun/bin/bun');
});

test('every product env value and the runtime give way to one set explicitly', (t) => {
  const explicit = Object.fromEntries(PRODUCT_KEYS.map((name) => [name, `/explicit/${name.toLowerCase()}`]));
  assert.deepEqual(runPackedEnvProbe(t, explicit).seen, explicit);
});

test('the bin marks the runtime it pinned, and leaves one set by hand unmarked', () => {
  const base = { homeDir: '/home/person', pluginPath: PLUGIN, productEnv: PRODUCT_ENV, nodePath: '/opt/node/bin/node', bunVersion: undefined };
  const pinned = prepareCliEnvironment({ ...base, env: {} }).env;
  assert.equal(pinned.BUN_BINARY, '/opt/node/bin/node');
  assert.equal(pinned.MITTRCRAFT_BIN_BUN_BINARY, '/opt/node/bin/node');
  assert.equal(prepareCliEnvironment({ ...base, env: { BUN_BINARY: '/opt/bun/bin/bun' } }).env.MITTRCRAFT_BIN_BUN_BINARY, undefined);
});

test('run by Bun, the bin refuses plain company sign-in secrets and points to Node or the file form', () => {
  const base = { homeDir: '/home/person', pluginPath: PLUGIN, productEnv: PRODUCT_ENV, bunVersion: '1.3.14' };
  const both = prepareCliEnvironment({ ...base, env: { MITTR_AD_CLIENT_SECRET: 'entra-secret', MITTR_AD_BIND_PASSWORD: 'bind-secret' } }).refusal;
  assert.equal(both, 'mittrcraft: this copy runs on Bun, which hands MITTR_AD_CLIENT_SECRET and MITTR_AD_BIND_PASSWORD to every program the server starts, agents\' commands included. Run mittrcraft with Node, or put each secret in a file named by MITTR_AD_CLIENT_SECRET_FILE and MITTR_AD_BIND_PASSWORD_FILE and unset the plain variables.');
  assert.ok(!both.includes('entra-secret') && !both.includes('bind-secret'));
  assert.match(prepareCliEnvironment({ ...base, env: { MITTR_AD_BIND_PASSWORD: 'x' } }).refusal, /MITTR_AD_BIND_PASSWORD_FILE and unset the plain variable\.$/);

  assert.equal(prepareCliEnvironment({ ...base, env: { MITTR_AD_CLIENT_ID: 'app', MITTR_AD_CLIENT_SECRET_FILE: '/run/secrets/entra' } }).refusal, null);
  assert.equal(prepareCliEnvironment({ ...base, env: { MITTR_AD_CLIENT_SECRET: ' ' } }).refusal, null);
  assert.equal(prepareCliEnvironment({ ...base, bunVersion: undefined, env: { MITTR_AD_CLIENT_SECRET: 'entra-secret' } }).refusal, null);
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
  for (const file of ['bin/mittrcraft.mjs', 'bin/openchamber.mjs', 'bin/product-env.json', 'src/cli-env.js', 'src/plugin.js', 'src/web-brand.js', 'src/web-brand.json']) {
    assert.ok(packed.includes(file), `${file} is not in the pack`);
  }
});

test('the npm pack of this package, beside only a sibling web and its own dependencies, loads its server plugin on serve', (t) => {
  const { root, packageDir } = tempLayout(t, 'mittrcraft-packed-plugin-');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(npm_|OPENCHAMBER_|OPENCODE_|XDG_|MITTR)/i.test(name)));
  const packEnv = { ...inherited, HOME: root, USERPROFILE: root, npm_config_cache: path.join(root, 'npm-cache'), npm_config_update_notifier: 'false' };
  const pack = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], {
    encoding: 'utf8',
    cwd: path.join(repoRoot, 'packages/mittr-server'),
    timeout: 60_000,
    env: packEnv,
  });
  assert.equal(pack.status, 0, pack.stderr);
  const tarball = path.join(root, JSON.parse(pack.stdout)[0].filename);
  const unpack = spawnSync('tar', ['-xzf', tarball, '-C', packageDir, '--strip-components=1'], { encoding: 'utf8' });
  assert.equal(unpack.status, 0, unpack.stderr);
  fs.mkdirSync(path.join(packageDir, 'node_modules'));
  fs.symlinkSync(fs.realpathSync(path.join(repoRoot, 'packages/mittr-server/node_modules/ldapjs')), path.join(packageDir, 'node_modules', 'ldapjs'), 'dir');

  const web = path.join(root, 'packages', 'web');
  fs.mkdirSync(path.join(web, 'bin'), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'packages/web/server'), path.join(web, 'server'), 'dir');
  fs.writeFileSync(path.join(web, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(web, 'bin', 'cli.js'), [
    "import { pathToFileURL } from 'node:url';",
    'const plugins = JSON.parse(process.env.OPENCHAMBER_SERVER_PLUGINS);',
    'for (const plugin of plugins) await import(pathToFileURL(plugin).href);',
    "console.log(JSON.stringify({ loaded: plugins }));",
    '',
  ].join('\n'));
  assert.equal(fs.existsSync(path.join(root, 'packages', 'mittr-opencode')), false);

  const result = runIsolated(t, path.join(packageDir, 'bin', 'mittrcraft.mjs'), ['serve', '--port', '9']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)), { loaded: [path.join(packageDir, 'src', 'plugin.js')] });
});

const RG_MISSING_MESSAGE = 'ripgrep (rg) is not installed on this server. Install it, or set MITTRCRAFT_ALLOW_RIPGREP_DOWNLOAD=1 to let the engine download it from github.com.';
const RG_DOWNLOAD_NOTICE = '[mittr] rg is missing; the engine will download it from github.com on first use';

const isListening = (port) => new Promise((resolve) => {
  const socket = net.connect({ port, host: '127.0.0.1' });
  socket.once('connect', () => {
    socket.destroy();
    resolve(true);
  });
  socket.once('error', () => resolve(false));
});

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const runPackedServe = (t, { pathValue, extraEnv = {}, args = ['serve'] }) => {
  const { root, packageDir } = packedBin(t, 'mittrcraft-packed-rg-');
  fs.mkdirSync(path.join(root, 'packages', 'web', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages', 'web', 'bin', 'cli.js'), "console.log('server started');\n");
  fs.writeFileSync(path.join(root, 'packages', 'web', 'package.json'), '{"type":"module"}\n');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittrcraft-bin-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCHAMBER_|OPENCODE_|XDG_|MITTR|PATH$)/.test(name)));
  return spawnSync(process.execPath, [path.join(packageDir, 'bin', 'mittrcraft.mjs'), ...args], {
    encoding: 'utf8',
    cwd: home,
    timeout: 60_000,
    env: { ...inherited, HOME: home, USERPROFILE: home, PATH: pathValue, ...extraEnv },
  });
};

test('a hosted start without rg refuses before listening', async (t) => {
  const port = await freePort();
  assert.equal(await isListening(port), false, `port ${port} is not free`);
  const emptyPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittrcraft-nopath-')));
  t.after(() => fs.rmSync(emptyPath, { recursive: true, force: true }));

  const result = runIsolated(t, BIN, ['serve', '--foreground', '--port', String(port)], { PATH: emptyPath });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), RG_MISSING_MESSAGE);
  assert.equal(await isListening(port), false);
  assert.deepEqual(fs.readdirSync(result.home), []);
});

test('rg on PATH starts normally', (t) => {
  const result = runPackedServe(t, { pathValue: RG_STUB_DIR });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'server started\n');
  assert.equal(result.stderr, '');
});

test('the opt-in allows the download with one log line', (t) => {
  const emptyPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittrcraft-nopath-')));
  t.after(() => fs.rmSync(emptyPath, { recursive: true, force: true }));

  const result = runPackedServe(t, { pathValue: emptyPath, extraEnv: { MITTRCRAFT_ALLOW_RIPGREP_DOWNLOAD: '1' } });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'server started\n');
  assert.equal(result.stderr, `${RG_DOWNLOAD_NOTICE}\n`);
});

test('commands that start no server need no rg', (t) => {
  const emptyPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittrcraft-nopath-')));
  t.after(() => fs.rmSync(emptyPath, { recursive: true, force: true }));

  for (const args of [['--help'], ['status'], ['stop']]) {
    const result = runPackedServe(t, { pathValue: emptyPath, args });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '', args.join(' '));
  }
});

const STARTUP_ENTRY = path.join(repoRoot, 'packages/mittr-server/bin/openchamber.mjs');

const startupStubDir = (t, { withRipgrep }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittrcraft-startup-stubs-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = ['systemctl', 'loginctl', 'schtasks.exe', ...(withRipgrep ? ['rg', 'rg.exe'] : [])];
  for (const name of names) fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return dir;
};

const runStartup = (t, platform, args, { withRipgrep = true, extraEnv = {} } = {}) => {
  const stubs = startupStubDir(t, { withRipgrep });
  const preload = path.join(stubs, 'platform.mjs');
  fs.writeFileSync(preload, `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });\n`);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittrcraft-bin-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCHAMBER_|OPENCODE_|XDG_|MITTR|PATH$)/.test(name)));
  const result = spawnSync(process.execPath, ['--import', preload, BIN, ...args], {
    encoding: 'utf8',
    cwd: home,
    timeout: 60_000,
    env: { ...inherited, HOME: home, USERPROFILE: home, PATH: stubs, OPENCHAMBER_DATA_DIR: path.join(home, 'data'), NO_COLOR: '1', ...extraEnv },
  });
  return { ...result, home };
};

test('the startup unit the bin writes runs the mittrcraft bin, not the upstream CLI', (t) => {
  const result = runStartup(t, 'linux', ['startup', 'enable', '--port', '3999']);

  assert.equal(result.status, 0, result.stderr);
  const unit = fs.readFileSync(path.join(result.home, '.config', 'systemd', 'user', 'openchamber.service'), 'utf8');
  const execStart = unit.split('\n').find((line) => line.startsWith('ExecStart='));
  assert.ok(execStart.includes(`"${STARTUP_ENTRY}" "serve" "--foreground" "--port" "3999"`), execStart);
  assert.ok(!execStart.includes(SERVER_CLI), execStart);
  assert.match(fs.readFileSync(STARTUP_ENTRY, 'utf8'), /import '\.\/mittrcraft\.mjs';/);
});

test('the Windows startup wrapper the bin writes runs the mittrcraft bin, not the upstream CLI', (t) => {
  const result = runStartup(t, 'win32', ['startup', 'enable', '--port', '3999'], { extraEnv: { MITTRCRAFT_ALLOW_RIPGREP_DOWNLOAD: '1' } });

  assert.equal(result.status, 0, result.stderr);
  const wrapper = fs.readFileSync(path.join(result.home, 'data', 'bin', 'OpenChamber.ps1'), 'utf8');
  assert.ok(wrapper.includes(STARTUP_ENTRY), wrapper);
  assert.ok(!wrapper.includes(SERVER_CLI), wrapper);
});

test('the startup entry runs the bin: it gates on rg and forwards the arguments', (t) => {
  const forwarded = runIsolated(t, STARTUP_ENTRY, ['--help']);
  const direct = runIsolated(t, SERVER_CLI, ['--help']);
  assert.equal(forwarded.status, 0, forwarded.stderr);
  assert.equal(forwarded.stdout, direct.stdout);

  const emptyPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittrcraft-nopath-')));
  t.after(() => fs.rmSync(emptyPath, { recursive: true, force: true }));
  const refused = runIsolated(t, STARTUP_ENTRY, ['serve', '--foreground', '--port', '9'], { PATH: emptyPath });
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr.trim(), RG_MISSING_MESSAGE);
});

test('startup enable without rg refuses and writes no unit, while status and disable are not gated', (t) => {
  const refused = runStartup(t, 'linux', ['startup', 'enable'], { withRipgrep: false });

  assert.equal(refused.status, 1);
  assert.equal(refused.stderr.trim(), RG_MISSING_MESSAGE);
  assert.equal(fs.existsSync(path.join(refused.home, '.config', 'systemd')), false);
  assert.equal(fs.existsSync(path.join(refused.home, 'data', 'startup.env')), false);

  for (const action of ['Enable', ' enable']) {
    const result = runStartup(t, 'linux', ['startup', action], { withRipgrep: false });
    assert.equal(result.status, 1, JSON.stringify(action));
    assert.equal(result.stderr.trim(), RG_MISSING_MESSAGE);
    assert.equal(fs.existsSync(path.join(result.home, '.config', 'systemd')), false);
  }

  for (const action of ['status', 'disable']) {
    const result = runStartup(t, 'linux', ['startup', action], { withRipgrep: false });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stderr.includes(RG_MISSING_MESSAGE), action);
  }
});

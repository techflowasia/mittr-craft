import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  ENGLISH_SNAPSHOT_FILE,
  UPSTREAM_CONTRACT,
  compareEnglishSnapshot,
  readEnglishOverrides,
  repoRoot,
} from './upstream-contract.js';

const source = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
const importUpstream = (relative) => import(pathToFileURL(path.join(repoRoot, relative)).href);
const item = (id) => UPSTREAM_CONTRACT.find((entry) => entry.id === id);
const lineCount = (text, needle) => text.split(needle).length - 1;
// `assert.match` prints the whole file on failure; these are long sources.
const has = (text, pattern, message = `no longer matches ${pattern}`) => assert.ok(pattern.test(text), message);

const tempDir = (t, prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// Runs `product-runtime.mjs` in a child process with `electron` stubbed to an
// app whose `product.json` is the given one, then reads what the server side
// of each variable makes of the environment it left behind.
const runProductRuntime = (t, product) => {
  const appPath = tempDir(t, 'contract-app-');
  const home = tempDir(t, 'contract-home-');
  fs.writeFileSync(path.join(appPath, 'product.json'), JSON.stringify(product));
  const script = `
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier !== 'electron') return nextResolve(specifier, context);
        const stub = 'export const app = { getAppPath: () => process.env.CONTRACT_APP_PATH };';
        return { url: 'data:text/javascript,' + encodeURIComponent(stub), shortCircuit: true };
      },
    });
    await import(process.env.CONTRACT_RUNTIME_URL);
    const { readServerPluginSpecifiers } = await import(process.env.CONTRACT_SERVER_PLUGINS_URL);
    const { policyFilePaths } = await import(process.env.CONTRACT_ENTERPRISE_URL);
    console.log(JSON.stringify({
      serverPluginsEnv: process.env.OPENCHAMBER_SERVER_PLUGINS ?? null,
      specifiers: readServerPluginSpecifiers(process.env),
      policyFiles: policyFilePaths({ platform: 'darwin', env: process.env }),
    }));
  `;
  const childEnv = { ...process.env };
  delete childEnv.OPENCHAMBER_SERVER_PLUGINS;
  delete childEnv.OPENCHAMBER_POLICY_FILE;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: {
      ...childEnv,
      HOME: home,
      CONTRACT_APP_PATH: appPath,
      CONTRACT_RUNTIME_URL: pathToFileURL(path.join(repoRoot, 'packages/electron/product-runtime.mjs')).href,
      CONTRACT_SERVER_PLUGINS_URL: pathToFileURL(path.join(repoRoot, 'packages/web/server/lib/server-plugins.js')).href,
      CONTRACT_ENTERPRISE_URL: pathToFileURL(path.join(repoRoot, 'packages/web/server/lib/enterprise-mode.js')).href,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return { appPath, home, ...JSON.parse(result.stdout.trim().split('\n').at(-1)) };
};

const checks = {
  'managed-opencode-env': () => {
    const lifecycle = source('packages/web/server/lib/opencode/lifecycle.js');
    has(lifecycle, /getManagedOpenCodeEnv = async \(\) => \(\{\}\)/, 'lifecycle no longer takes getManagedOpenCodeEnv with an empty default');
    has(lifecycle, /const managedOpenCodeEnv = await getManagedOpenCodeEnv\(\);/, 'lifecycle no longer reads the managed env before starting OpenCode');
    assert.ok(lineCount(lifecycle, '...managedOpenCodeEnv') >= 3, 'the managed env no longer reaches the preflight, the V1 top-up and the spawn');

    const server = source('packages/web/server/index.js');
    has(server, /getManagedOpenCodeEnv: async \(\) => \(\{\s*\.\.\.\(managedConfigRuntime \? await managedConfigRuntime\.buildManagedChildEnv\(\) : \{\}\),\s*\.\.\.\(await getServerPluginEngineEnv\(\)\),\s*\}\)/);
    assert.ok(lineCount(server, '...(await getServerPluginEngineEnv())') >= 3, 'the plugin engine env no longer reaches the managed env, the v2 install and the CLI upgrade');
    has(server, /readOpenCodeCliVersion\([^)]*\), \{\s*env: \{ \.\.\.process\.env, \.\.\.\(await getServerPluginEngineEnv\(\)\) \}/);
  },

  'server-plugins-env': async (t) => {
    const { readServerPluginSpecifiers, loadServerPlugins } = await importUpstream('packages/web/server/lib/server-plugins.js');
    assert.deepEqual(readServerPluginSpecifiers({}), []);
    assert.deepEqual(readServerPluginSpecifiers({ OPENCHAMBER_SERVER_PLUGINS: ' ' }), []);
    assert.deepEqual(readServerPluginSpecifiers({ OPENCHAMBER_SERVER_PLUGINS: '["/a/plugin.mjs"]' }), ['/a/plugin.mjs']);
    assert.throws(() => readServerPluginSpecifiers({ OPENCHAMBER_SERVER_PLUGINS: '["relative.mjs"]' }));

    const dir = tempDir(t, 'contract-plugin-');
    const first = path.join(dir, 'first.mjs');
    const second = path.join(dir, 'second.mjs');
    fs.writeFileSync(first, 'export default async (context) => ({ engineEnv: () => ({ A: "1", SEEN: String(context.dataDir) }) });');
    fs.writeFileSync(second, 'export default () => ({ engineEnv: async () => ({ A: "2" }) });');
    const plugins = await loadServerPlugins({ specifiers: [first, second], context: { app: {}, dataDir: '/data', logger: console } });
    assert.deepEqual(await plugins.engineEnv(), { A: '2', SEEN: '/data' });

    const server = source('packages/web/server/index.js');
    has(server, /serverPlugins = await loadServerPlugins\(\{\s*specifiers: readServerPluginSpecifiers\(process\.env\),\s*context: \{ app, dataDir: OPENCHAMBER_DATA_DIR, logger: console \},/);
    assert.ok(server.indexOf('serverPlugins = await loadServerPlugins(') < server.indexOf('guestSurfaceRuntime = createGuestSurfaceRuntime('), 'server plugins no longer load before the startup pipeline');

    const pluginSource = source('packages/mittr-server/src/plugin.js');
    has(pluginSource, /export default async function setup\(\{ dataDir, logger \}\)/, 'our plugin no longer takes the context the loader passes');
  },

  'product-runtime-server-plugins': (t) => {
    const withPlugins = runProductRuntime(t, {
      serverPlugins: ['product-plugins/one.mjs'],
      env: { OPENCHAMBER_POLICY_FILE: '~/policy.json' },
    });
    assert.equal(withPlugins.serverPluginsEnv, JSON.stringify([path.join(withPlugins.appPath, 'product-plugins/one.mjs')]));
    assert.deepEqual(withPlugins.specifiers, [path.join(withPlugins.appPath, 'product-plugins/one.mjs')]);
    assert.deepEqual(withPlugins.policyFiles, [path.join(withPlugins.home, 'policy.json')]);

    const without = runProductRuntime(t, {});
    assert.equal(without.serverPluginsEnv, null);
    assert.deepEqual(without.specifiers, []);

    has(source('packages/electron/early-startup.mjs'), /^import \{ PRODUCT \} from '\.\/product-runtime\.mjs';$/m, 'early startup no longer resolves the product first');
  },

  'policy-file-env': async () => {
    const { policyFilePaths } = await importUpstream('packages/web/server/lib/enterprise-mode.js');
    assert.deepEqual(policyFilePaths({ platform: 'darwin', env: { OPENCHAMBER_POLICY_FILE: '/x/policy.json' } }), ['/x/policy.json']);
    assert.deepEqual(policyFilePaths({ platform: 'darwin', env: {} }), ['/Library/Application Support/OpenChamber/policy.json']);
    for (const flavor of ['dev', 'prod']) {
      const product = JSON.parse(source(`brand/product.${flavor}.json`));
      has(product.env.OPENCHAMBER_POLICY_FILE, /^\/Library\/Application Support\/MittrCraft( Dev)?\/policy\.json$/);
    }
  },

  'managed-process-registry-env': async (t) => {
    const { createManagedProcessRegistry } = await importUpstream('packages/web/server/lib/opencode/managed-process-registry.js');
    const dir = '/contract/registry';
    const previous = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
    process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = dir;
    t.after(() => {
      if (previous === undefined) delete process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
      else process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = previous;
    });
    // Nothing reaches the disk: a registry that ignored the variable would
    // otherwise write into the real ~/.config/openchamber.
    const touched = [];
    const recordingFs = {
      mkdir: async (target) => { touched.push(target); },
      writeFile: async (target) => { touched.push(target); },
      rename: async (from, to) => { touched.push(to); },
    };
    const registry = createManagedProcessRegistry({ fs: recordingFs });
    await registry.registerManagedProcess({ pid: 4242, ownerPid: process.pid, port: 1, binary: 'opencode', runtime: 'contract' });
    assert.ok(touched.length > 0, 'registering a process no longer writes an entry');
    assert.deepEqual(touched.filter((target) => !target.startsWith(`${dir}${path.sep}`) && target !== dir), []);
    for (const flavor of ['dev', 'prod']) {
      const product = JSON.parse(source(`brand/product.${flavor}.json`));
      has(product.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY, /^~\/\.config\/mittrcraft(-dev)?\/managed-opencode$/);
    }
  },

  'product-json-keys': async () => {
    const { UPSTREAM_PRODUCT } = await importUpstream('packages/electron/product.mjs');
    const recorded = item('product-json-keys').keys;
    assert.deepEqual(Object.keys(UPSTREAM_PRODUCT).sort(), [...recorded].sort());
    for (const flavor of ['dev', 'prod']) {
      const unknown = Object.keys(JSON.parse(source(`brand/product.${flavor}.json`))).filter((key) => !recorded.includes(key));
      assert.deepEqual(unknown, [], `brand/product.${flavor}.json has keys Electron never reads`);
    }
    const electron = ['main.mjs', 'early-startup.mjs', 'entry.mjs', 'product-runtime.mjs', 'product.mjs']
      .map((file) => source(`packages/electron/${file}`))
      .join('\n');
    for (const key of recorded) {
      has(electron, new RegExp(`\\b(?:PRODUCT|product)\\.${key}\\b`), `nothing in the desktop shell reads product.${key}`);
    }
  },

  'i18n-overlay': () => {
    const store = source('packages/ui/src/lib/i18n/store.ts');
    has(store, /^import \{ overlayDictionary, subscribeProductUiPlugins \} from '\.\.\/product-plugins';$/m);
    const raw = store.split('\n')
      .filter((line) => /\bdictionary:\s|[{,]\s*dictionary\s*[,}]/.test(line) && !/dictionary: I18nDictionary/.test(line))
      .filter((line) => !line.includes('overlayDictionary(') && !/: current\.dictionary/.test(line));
    assert.deepEqual(raw, [], 'the i18n store sets a dictionary without the product overlay');
    has(store, /const template = dictionary\[key\] \?\? overlayDictionary\(DEFAULT_LOCALE, enDict\)\[key\] \?\? key;/);
    has(store, /subscribeProductUiPlugins\(\(\) => \{[\s\S]*?dictionaries\.get\(locale\)/);

    const plugins = source('packages/ui/src/lib/product-plugins.ts');
    for (const name of ['registerProductUiPlugin', 'subscribeProductUiPlugins', 'overlayDictionary', 'getProductLogo']) {
      has(plugins, new RegExp(`^export function ${name}\\(`, 'm'), `product-plugins no longer exports ${name}`);
    }
  },

  'ui-plugin-glob': () => {
    const { line, files } = item('ui-plugin-glob');
    for (const file of files) {
      const text = source(file);
      const found = text.split('\n').find((candidate) => candidate.startsWith("import.meta.glob('"));
      assert.equal(found?.replace(/;$/, ''), line[file], `${file} lost the product UI plugin glob`);
      const pattern = found.match(/import\.meta\.glob\('([^']+)'/)[1];
      const matched = fs.globSync(pattern, { cwd: path.join(repoRoot, path.dirname(file)) })
        .map((match) => path.relative(repoRoot, path.resolve(repoRoot, path.dirname(file), match)));
      assert.ok(matched.includes('packages/mittr-ui/src/product-ui-plugin.tsx'), `${file}'s glob no longer reaches our UI plugin`);
    }
  },

  'english-overrides': () => {
    const snapshot = JSON.parse(source(ENGLISH_SNAPSHOT_FILE));
    const problems = compareEnglishSnapshot(snapshot, readEnglishOverrides());
    assert.deepEqual(problems, [], `English overrides to re-check:\n${problems.join('\n')}`);
  },

  'after-pack-hook': () => {
    const { file, sha256 } = item('after-pack-hook');
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(repoRoot, file))).digest('hex');
    assert.equal(actual, sha256, `${file} changed upstream; our build drops it (afterPack: null), so read the change and decide`);
    assert.equal(JSON.parse(source('packages/electron/package.json')).build.afterPack, 'scripts/after-pack.cjs');
    for (const flavor of ['dev', 'prod']) {
      assert.equal(JSON.parse(source(`brand/electron-builder.${flavor}.json`)).afterPack, null);
    }
  },

  'staged-server-packing': async () => {
    const { asarUnpack, nativeModules } = item('staged-server-packing');
    const upstreamBuild = JSON.parse(source('packages/electron/package.json')).build;
    assert.deepEqual(upstreamBuild.asarUnpack, asarUnpack, 'upstream changed what it keeps out of the asar');
    const workspacePath = (pattern) => pattern.replace('node_modules/@openchamber/web/', 'packages/web/').replace(/\/\*\*\/\*$/, '');
    const [generated, helpers] = [asarUnpack.filter((pattern) => pattern.endsWith('/**/*')), asarUnpack.filter((pattern) => !pattern.endsWith('/**/*'))];
    for (const pattern of helpers) {
      assert.ok(fs.existsSync(path.join(repoRoot, workspacePath(pattern))), `${workspacePath(pattern)} is gone`);
    }

    // The built-in extensions folder is build output (gitignored), so the
    // contract reads its source and the step that writes it, never the output.
    assert.deepEqual(generated.map(workspacePath), ['packages/web/server/built-in-extensions']);
    const sourceRegistry = JSON.parse(source('packages/extensions/registry.json'));
    assert.equal(sourceRegistry.version, 1);
    assert.ok(Array.isArray(sourceRegistry.extensions), 'packages/extensions/registry.json lists no extensions array');
    const { DEFAULT_BUILTIN_ROOT } = await importUpstream('packages/web/server/lib/guests/builtins.js');
    assert.equal(path.relative(repoRoot, DEFAULT_BUILTIN_ROOT), 'packages/web/server/built-in-extensions', 'the server reads built-in extensions from another folder');
    const builder = source('scripts/build-builtin-extensions.mjs');
    has(builder, /import \{[^}]*\bDEFAULT_BUILTIN_ROOT\b[^}]*\} from '\.\.\/packages\/web\/server\/lib\/guests\/builtins\.js';/, 'the extension build no longer takes its out dir from the server');
    has(builder, /sourceRoot = path\.join\(repoRoot, 'packages\/extensions'\), outDir = DEFAULT_BUILTIN_ROOT/, 'the extension build no longer writes the source registry to the folder we keep unpacked');
    has(JSON.parse(source('packages/web/package.json')).scripts.build, /build-builtin-extensions\.mjs/, 'the web build no longer builds the built-in extensions before packing');

    const { stagedServerFiles } = await import(pathToFileURL(path.join(repoRoot, 'scripts/mittr/build-desktop.mjs')).href);
    const files = stagedServerFiles(upstreamBuild.asarUnpack);
    for (const pattern of asarUnpack) assert.ok(files.includes(pattern), `${pattern} is no longer packed from the workspace`);

    const rebuild = source('packages/electron/scripts/rebuild-native.mjs');
    has(rebuild, new RegExp(`onlyModules: \\[${nativeModules.map((name) => `'${name}'`).join(', ')}\\]`), 'upstream changed which native modules it rebuilds');
    const webPackage = JSON.parse(source('packages/web/package.json'));
    for (const name of nativeModules) assert.ok(webPackage.dependencies?.[name] || webPackage.optionalDependencies?.[name], `${name} is no longer a web dependency`);
    const nativeInServer = fs.globSync('**/*.node', { cwd: path.join(repoRoot, 'packages/web/server') });
    assert.deepEqual(nativeInServer, [], 'a native module sits in the server folder, which the build packs from a copy');

    has(source('packages/electron/main.mjs'), /process\.env\.OPENCHAMBER_DIST_DIR = resolveWebDistDir\(\);/);
    has(source('packages/web/server/lib/opencode/static-routes-runtime.js'), /process\.env\.OPENCHAMBER_DIST_DIR/);
  },
};

test('every contract item has a check, and every check an item', () => {
  assert.deepEqual(UPSTREAM_CONTRACT.map((entry) => entry.id).sort(), Object.keys(checks).sort());
  for (const entry of UPSTREAM_CONTRACT) {
    assert.ok(entry.files.length > 0 && entry.why, `${entry.id} names no file or reason`);
    for (const file of entry.files) assert.ok(fs.existsSync(path.join(repoRoot, file)), `${entry.id}: ${file} is gone`);
  }
});

for (const entry of UPSTREAM_CONTRACT) {
  test(`${entry.id}: ${entry.why}`, (t) => checks[entry.id]?.(t));
}

test('a stale English override names the key and shows the old and new upstream text', () => {
  const problems = compareEnglishSnapshot(
    { 'a.kept': 'Same', 'a.changed': 'Old text', 'a.removed': 'Gone', 'a.unused': 'Not overridden' },
    {
      overrides: { 'a.kept': 'x', 'a.changed': 'x', 'a.removed': 'x', 'a.new': 'x' },
      upstream: { 'a.kept': 'Same', 'a.changed': 'New text', 'a.new': 'Fresh' },
    },
  );
  assert.deepEqual(problems, [
    'a.changed: upstream English changed from "Old text" to "New text"',
    'a.removed: no longer exists upstream (was "Gone")',
    'a.new: overridden but not in the snapshot (upstream "Fresh")',
    'a.unused: in the snapshot but no longer overridden',
  ]);
});

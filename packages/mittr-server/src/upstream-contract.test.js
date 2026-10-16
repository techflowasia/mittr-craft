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
        const stub = 'export const app = { getAppPath: () => process.env.CONTRACT_APP_PATH, getVersion: () => "9.8.7+contract.1" };';
        return { url: 'data:text/javascript,' + encodeURIComponent(stub), shortCircuit: true };
      },
    });
    await import(process.env.CONTRACT_RUNTIME_URL);
    const { readServerPluginSpecifiers } = await import(process.env.CONTRACT_SERVER_PLUGINS_URL);
    const { policyFilePaths } = await import(process.env.CONTRACT_ENTERPRISE_URL);
    console.log(JSON.stringify({
      serverPluginsEnv: process.env.OPENCHAMBER_SERVER_PLUGINS ?? null,
      hostAppVersion: process.env.OPENCHAMBER_HOST_APP_VERSION ?? null,
      specifiers: readServerPluginSpecifiers(process.env),
      policyFiles: policyFilePaths({ platform: 'darwin', env: process.env }),
    }));
  `;
  const childEnv = { ...process.env };
  delete childEnv.OPENCHAMBER_SERVER_PLUGINS;
  delete childEnv.OPENCHAMBER_HOST_APP_VERSION;
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

// Runs a module script in a child process whose HOME is a fresh temp home and
// whose data dir sits inside it, with no GIT_* variable from the caller, so a
// check can see whether upstream reaches for ~/.config/openchamber.
const runInTempHome = (t, script, env = {}) => {
  const home = tempDir(t, 'contract-home-');
  const dataDir = path.join(home, 'data');
  fs.mkdirSync(dataDir);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...inherited, HOME: home, OPENCHAMBER_DATA_DIR: dataDir, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return { home, dataDir, output: JSON.parse(result.stdout.trim().split('\n').at(-1)), legacyDir: path.join(home, '.config', 'openchamber') };
};

const git = (cwd, ...args) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

// The context literal index.js hands every server plugin, from the loader
// call to the first statement after it.
const pluginContext = (server) => {
  const start = server.indexOf('serverPlugins = await loadServerPlugins(');
  const end = server.indexOf('guestSurfaceRuntime = createGuestSurfaceRuntime(', start);
  assert.ok(start >= 0 && end > start, 'index.js no longer loads server plugins before the guest surface runtime');
  return server.slice(start, end);
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
    assert.deepEqual(await plugins.managedConfig(), {});
    await plugins.dispose();

    const server = source('packages/web/server/index.js');
    const context = pluginContext(server);
    has(context, /^serverPlugins = await loadServerPlugins\(\{\s*specifiers: readServerPluginSpecifiers\(process\.env\),\s*context: \{\s*app,\s*express,\s*dataDir: OPENCHAMBER_DATA_DIR,\s*logger: console,/);
    for (const entry of [
      /settings: \{ read: \(\) => readSettingsFromDiskMigrated\(\) \},/,
      /subscribe: \(listener\) => globalMessageStreamHub\.subscribeEvent\(listener\),/,
      /url: \(route = '\/'\) => buildOpenCodeUrl\(route\),/,
      /authHeaders: \(\) => getOpenCodeAuthHeaders\(\),/,
      /restart: async \(reason\) => \{ await restartOpenCode\(reason\); \},/,
      /refresh: async \(reason\) => \{ await refreshOpenCodeAfterConfigChange\(reason\); \},/,
      /waitReady: \(\) => waitForOpenCodeReady\(\),/,
      /defaultDirectory: \(\) => openCodeLifecycleRuntime\.getDefaultOpenCodeDirectory\(\),/,
      /userConfig: \{\s*path: OPENCODE_USER_CONFIG_FILE,\s*read: \(\) => readOpenCodeConfigFile\(OPENCODE_USER_CONFIG_FILE\),\s*write: \(config\) => writeOpenCodeConfig\(config, OPENCODE_USER_CONFIG_FILE\),\s*\},/,
      /git: \{ remoteUrl: \(directory\) => getRemoteUrl\(directory, 'origin'\) \},/,
      /managedConfig: \{ refresh: \(\) => managedConfigRuntime\.refreshManagedConfigFile\(\) \},/,
      /host: options\.pluginHost \?\? null,/,
      /requestScope: \(req\) => tunnelAuthController\.classifyRequestScope\(req\),/,
      /onShutdown: \(handler\) => \{\s*serverPluginShutdownHandlers\.push\(handler\);\s*\},/,
    ]) has(context, entry, `the server plugin context no longer has ${entry}`);
    has(server, /import \{\s*CONFIG_FILE as OPENCODE_USER_CONFIG_FILE,\s*readConfigFile as readOpenCodeConfigFile,\s*writeConfig as writeOpenCodeConfig,\s*\} from '\.\/lib\/opencode\/shared\.js';/);
    has(server, /import \{ getRemoteUrl, resolvePrimaryWorktreeRoot \} from '\.\/lib\/git\/service\.js';/);
    has(source('packages/web/server/lib/git/service.js'), /export async function getRemoteUrl\(directory, remoteName = 'origin'\) \{\s*const git = await createGit\(directory\);\s*try \{\s*const url = await git\.remote\(\['get-url', '--', remoteName\]\);/);
    has(source('packages/web/server/lib/opencode/tunnel-auth.js'), /const classifyRequestScope = \(req\) => \{/);
    has(server, /stopAllGuestServices: async \(\) => \{\s*try \{\s*await stopServerPlugins\(\);\s*\} finally \{\s*await stopAllGuestServices\(\);\s*\}\s*\},/, 'server plugins no longer stop inside the graceful shutdown');
    const shutdown = source('packages/web/server/lib/opencode/shutdown-runtime.js');
    assert.ok(shutdown.indexOf('stopAllGuestServices,\n    ];') >= 0 && shutdown.indexOf('stopAllGuestServices,\n    ];') < shutdown.indexOf("console.log('Stopping OpenCode process...')"), 'graceful shutdown no longer stops guest services before OpenCode');
    has(server, /await serverPlugins\?\.dispose\(\);/);

    const pluginSource = source('packages/mittr-server/src/plugin.js');
    has(pluginSource, /export default async function setup\(\{ dataDir, logger \}\)/, 'our plugin no longer takes the context the loader passes');
  },

  'managed-config-contributions': async (t) => {
    const { createManagedConfigRuntime, MANAGED_CONFIG_FILE_NAME } = await importUpstream('packages/web/server/lib/opencode/managed-config-file.js');
    const contribution = {
      providers: { contract: { name: 'Contract' } },
      plugins: ['/contract/plugin'],
      experimental: { policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }] },
    };
    const runtime = (env) => {
      const dataDir = tempDir(t, 'contract-managed-');
      return {
        dataDir,
        managed: createManagedConfigRuntime({
          fsPromises: fs.promises,
          path,
          dataDir,
          env,
          readSettings: async () => ({}),
          isAgentMemoryAvailable: () => false,
          contributeConfig: async () => contribution,
        }),
      };
    };

    const owned = runtime({});
    assert.equal((await owned.managed.buildManagedChildEnv()).OPENCODE_CONFIG, path.join(owned.dataDir, MANAGED_CONFIG_FILE_NAME));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(owned.dataDir, MANAGED_CONFIG_FILE_NAME), 'utf8')), {
      ...contribution,
      plugins: ['-opencode.browser', '/contract/plugin'],
    });

    const userOwned = runtime({ OPENCODE_CONFIG: '/user/opencode.json', OPENCODE_CONFIG_CONTENT: '{"model":"user/model"}' });
    const content = JSON.parse((await userOwned.managed.buildManagedChildEnv()).OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(content, { model: 'user/model', ...contribution, plugins: ['-opencode.browser', '/contract/plugin'] });

    has(source('packages/web/server/lib/opencode/managed-config-file.js'), /import \{ mergeEngineConfig \} from '\.\.\/server-plugins\.js';/, 'the managed config no longer merges with the same rule');
    const server = source('packages/web/server/index.js');
    has(server, /managedConfigRuntime = createManagedConfigRuntime\(\{[^}]*contributeConfig: \(\) => \(serverPlugins \? serverPlugins\.managedConfig\(\) : \{\}\),\s*\}\);/, 'index.js no longer hands the managed config runtime what server plugins contribute');
  },

  'plugin-context-express': () => {
    const server = source('packages/web/server/index.js');
    has(server, /^import express from 'express';$/m);
    has(pluginContext(server), /context: \{\s*app,\s*express,/, 'the plugin context no longer carries the server\'s express module');
  },

  'plugin-context-server-port': () => {
    const server = source('packages/web/server/index.js');
    has(server, /^let server = null;$/m);
    has(server, /server = http\.createServer\(app\);/);
    has(pluginContext(server), /server: \{\s*port: \(\) => \{\s*const address = server\?\.address\?\.\(\);\s*return address && Number\.isInteger\(address\.port\) \? address\.port : null;\s*\},\s*\},/, 'the plugin context no longer reports the bound port as getActivePort does');
  },

  'engine-on-ready': () => {
    const lifecycle = source('packages/web/server/lib/opencode/lifecycle.js');
    has(lifecycle, /onEngineReady = \(\) => \{\},/, 'lifecycle no longer takes onEngineReady with a no-op default');
    has(lifecycle, /const serverInstance = await startOpenCodeOnce\(attempt\);\s*notifyEngineReady\(\);\s*return serverInstance;/, 'a managed start no longer notifies once it is ready');
    has(lifecycle, /state\.openCodeProcess = await startOpenCode\(\);/, 'a managed restart no longer goes through startOpenCode');

    const server = source('packages/web/server/index.js');
    has(server, /onEngineReady: notifyEngineReadyListeners,\s*\}\);/, 'index.js no longer fans the lifecycle\'s ready call out to plugins');
    has(pluginContext(server), /onReady: \(listener\) => \{\s*engineReadyListeners\.add\(listener\);\s*return \(\) => engineReadyListeners\.delete\(listener\);\s*\},/);
  },

  'plugin-ui-event-broadcast': () => {
    const server = source('packages/web/server/index.js');
    has(server, /const broadcastOpenChamberUiEvent = createGlobalUiEventBroadcaster\(\{\s*sseClients: uiOpenChamberEventClients,/);
    has(pluginContext(server), /broadcast: \(type, payload\) => broadcastOpenChamberUiEvent\(\{ type, properties: payload \}\),/, 'a plugin event no longer goes out on the OpenChamber UI event stream');
  },

  'merge-engine-config': async () => {
    const { mergeEngineConfig } = await importUpstream('packages/web/server/lib/server-plugins.js');
    assert.deepEqual(
      mergeEngineConfig(
        { model: 'a', providers: { x: { name: 'X' } }, plugins: ['/1'], experimental: { policies: [{ resource: '*', effect: 'deny' }] } },
        { model: 'b', providers: { x: { models: {} } }, plugins: ['/2'], experimental: { policies: [{ resource: 'x', effect: 'allow' }] } },
      ),
      {
        model: 'b',
        providers: { x: { name: 'X', models: {} } },
        plugins: ['/1', '/2'],
        experimental: { policies: [{ resource: '*', effect: 'deny' }, { resource: 'x', effect: 'allow' }] },
      },
    );
    const server = source('packages/web/server/index.js');
    has(server, /import \{ loadServerPlugins, mergeEngineConfig, readServerPluginSpecifiers \} from '\.\/lib\/server-plugins\.js';/);
    has(pluginContext(server), /^\s*mergeEngineConfig,$/m, 'the plugin context no longer carries mergeEngineConfig');
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

  'server-app-version': (t) => {
    assert.equal(runProductRuntime(t, { serverReportsAppVersion: true }).hostAppVersion, '9.8.7+contract.1');
    assert.equal(runProductRuntime(t, {}).hostAppVersion, null);
    has(source('packages/web/server/index.js'), /const OPENCHAMBER_VERSION = \(\(\) => \{\s*(\/\/.*\n\s*)*const hostAppVersion = process\.env\.OPENCHAMBER_HOST_APP_VERSION\?\.trim\(\);\s*if \(hostAppVersion\) \{\s*return hostAppVersion;/, 'the server no longer reports the version the shell hands it');
    for (const flavor of ['dev', 'prod']) {
      assert.equal(JSON.parse(source(`brand/product.${flavor}.json`)).serverReportsAppVersion, true, flavor);
    }
  },

  'update-check-disabled-env': () => {
    const routes = source('packages/web/server/lib/opencode/openchamber-routes.js');
    has(routes, /\} else if \(isUpdateCheckDisabled\(process\.env\)\) \{[\s\S]{0,400}updatesDisabled: true,[\s\S]{0,300}\} else \{\s*const \{ checkForUpdates \} = await import\('\.\.\/package-manager\.js'\);/, 'the update check no longer stops before calling the update service when switched off');
    for (const flavor of ['dev', 'prod']) {
      assert.equal(JSON.parse(source(`brand/product.${flavor}.json`)).env.OPENCHAMBER_UPDATE_CHECK_DISABLED, '1', flavor);
    }
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

  'git-identities-legacy-path': (t) => {
    const storage = source('packages/web/server/lib/git/identity-storage.js');
    has(storage, /const legacyDataDir = \(\) => path\.join\(os\.homedir\(\), '\.config', 'openchamber'\);/);
    has(storage, /const current = readFile\(filePath, true\);\s*if \(current\) \{/, 'upstream no longer reads its own file before the legacy one');
    const script = `
      const { getProfiles } = await import(process.env.CONTRACT_IDENTITIES_URL);
      console.log(JSON.stringify(getProfiles()));
    `;
    const env = { CONTRACT_IDENTITIES_URL: pathToFileURL(path.join(repoRoot, 'packages/web/server/lib/git/identity-storage.js')).href };

    const missing = runInTempHome(t, script, env);
    assert.deepEqual(missing.output, []);
    assert.equal(fs.existsSync(missing.legacyDir), true, 'a missing store no longer sends upstream to ~/.config/openchamber; review git-identities.js');

    const seededScript = `
      const { ensureGitIdentityStore } = await import(process.env.CONTRACT_OURS_URL);
      await ensureGitIdentityStore({ dataDir: process.env.OPENCHAMBER_DATA_DIR, homeDir: process.env.HOME });
      ${script}
    `;
    const seeded = runInTempHome(t, seededScript, {
      ...env,
      CONTRACT_OURS_URL: pathToFileURL(path.join(repoRoot, 'packages/mittr-server/src/git-identities.js')).href,
    });
    assert.deepEqual(seeded.output, []);
    assert.equal(fs.existsSync(seeded.legacyDir), false, 'upstream reached ~/.config/openchamber although the store exists');
  },

  'integrate-tmp-root': (t) => {
    const repo = tempDir(t, 'contract-integrate-');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Contract');
    git(repo, 'config', 'user.email', 'contract@example.test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'feature');
    const commit = git(repo, 'rev-parse', 'HEAD');

    const script = `
      const { integrateWorktreeCommits } = await import(process.env.CONTRACT_SERVICE_URL);
      const result = await integrateWorktreeCommits({
        repoRoot: process.env.CONTRACT_REPO, sourceBranch: 'feature', targetBranch: 'main', commits: [process.env.CONTRACT_COMMIT],
      });
      console.log(JSON.stringify(result));
    `;
    const run = runInTempHome(t, script, {
      CONTRACT_SERVICE_URL: pathToFileURL(path.join(repoRoot, 'packages/web/server/lib/git/service.js')).href,
      CONTRACT_REPO: repo,
      CONTRACT_COMMIT: commit,
    });
    assert.deepEqual(run.output, { kind: 'success', moved: 1 });
    assert.equal(git(repo, 'show', 'main:b.txt'), 'b');
    assert.equal(fs.existsSync(path.join(run.dataDir, 'tmp')), true, 'the integrate worktree no longer goes under the data dir');
    assert.equal(fs.existsSync(run.legacyDir), false, 'the integrate worktree went under ~/.config/openchamber');
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

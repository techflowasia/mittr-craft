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

// Starts the real server in a fresh child process (the server module holds
// one server per process) with one probe plugin, makes one request to it and
// stops. The child gets a temp HOME and data dir and never starts OpenCode.
const probeRealServer = (t, pluginSource, { uiPassword = '', method = 'GET', route, body } = {}) => {
  const dir = tempDir(t, 'contract-probe-');
  const plugin = path.join(dir, 'probe-plugin.mjs');
  fs.writeFileSync(plugin, pluginSource);
  const script = `
    const { startWebUiServer } = await import(process.env.CONTRACT_SERVER_URL);
    const handle = await startWebUiServer({ port: 0, host: '127.0.0.1', attachSignals: false, exitOnShutdown: false, uiPassword: process.env.CONTRACT_UI_PASSWORD });
    const body = process.env.CONTRACT_BODY;
    const response = await fetch('http://127.0.0.1:' + handle.httpServer.address().port + process.env.CONTRACT_ROUTE, {
      method: process.env.CONTRACT_METHOD,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body || undefined,
    });
    const text = await response.text();
    await handle.stop({ exitProcess: false });
    console.log(JSON.stringify({ status: response.status, text }));
    process.exit(0);
  `;
  const home = tempDir(t, 'contract-home-');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(GIT_|OPENCODE_|OPENCHAMBER_|XDG_)/.test(name)));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...inherited,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      XDG_STATE_HOME: path.join(home, '.local', 'state'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      OPENCHAMBER_DATA_DIR: path.join(home, 'data'),
      OPENCODE_SKIP_START: 'true',
      OPENCODE_PORT: '9',
      OPENCHAMBER_UPDATE_CHECK_DISABLED: '1',
      OPENCHAMBER_SERVER_PLUGINS: JSON.stringify([plugin]),
      CONTRACT_UI_PASSWORD: uiPassword,
      CONTRACT_METHOD: method,
      CONTRACT_ROUTE: route,
      CONTRACT_BODY: body === undefined ? '' : JSON.stringify(body),
      CONTRACT_SERVER_URL: pathToFileURL(path.join(repoRoot, 'packages/web/server/index.js')).href,
    },
  });
  assert.equal(result.status, 0, result.stderr || String(result.error ?? result.signal));
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
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
      /git: \{ remoteUrl: \(directory\) => getRemoteUrl\(directory, 'origin'\) \},/,
      /managedConfig: \{ refresh: \(\) => managedConfigRuntime\.refreshManagedConfigFile\(\) \},/,
      /host: options\.pluginHost \?\? null,/,
      /requestScope: \(req\) => tunnelAuthController\.classifyRequestScope\(req\),/,
      /onShutdown: \(handler\) => \{\s*serverPluginShutdownHandlers\.push\(handler\);\s*\},/,
    ]) has(context, entry, `the server plugin context no longer has ${entry}`);
    has(server, /import \{ getRemoteUrl, resolvePrimaryWorktreeRoot \} from '\.\/lib\/git\/service\.js';/);
    has(source('packages/web/server/lib/git/service.js'), /export async function getRemoteUrl\(directory, remoteName = 'origin'\) \{\s*const git = await createGit\(directory\);\s*try \{\s*const url = await git\.remote\(\['get-url', '--', remoteName\]\);/);
    has(source('packages/web/server/lib/opencode/tunnel-auth.js'), /const classifyRequestScope = \(req\) => \{/);
    has(server, /stopAllGuestServices: async \(\) => \{\s*try \{\s*await stopServerPlugins\(\);\s*\} finally \{\s*await stopAllGuestServices\(\);\s*\}\s*\},/, 'server plugins no longer stop inside the graceful shutdown');
    const shutdown = source('packages/web/server/lib/opencode/shutdown-runtime.js');
    assert.ok(shutdown.indexOf('stopAllGuestServices,\n    ];') >= 0 && shutdown.indexOf('stopAllGuestServices,\n    ];') < shutdown.indexOf("console.log('Stopping OpenCode process...')"), 'graceful shutdown no longer stops guest services before OpenCode');
    has(server, /await serverPlugins\?\.dispose\(\);/);

    const pluginSource = source('packages/mittr-server/src/plugin.js');
    has(pluginSource, /export default async function setup\(context\)/, 'our plugin no longer takes the context the loader passes');
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

    // OpenCode lets OPENCODE_CONFIG outrank project config and
    // OPENCODE_CONFIG_CONTENT for policies (P7 in the engine proof), so the
    // contribution keeps that layer and the user's config moves below it.
    const userDir = tempDir(t, 'contract-user-config-');
    const userFile = path.join(userDir, 'opencode.json');
    const userPolicy = { action: 'provider.use', resource: '*', effect: 'allow' };
    fs.writeFileSync(userFile, JSON.stringify({ model: 'file/model', experimental: { policies: [userPolicy] } }));
    const userOwned = runtime({ OPENCODE_CONFIG: userFile, OPENCODE_CONFIG_CONTENT: '{"model":"user/model"}' });
    const userEnv = await userOwned.managed.buildManagedChildEnv();
    assert.equal(userEnv.OPENCODE_CONFIG, path.join(userOwned.dataDir, MANAGED_CONFIG_FILE_NAME), 'a contribution no longer takes OPENCODE_CONFIG from the user');
    assert.deepEqual(JSON.parse(fs.readFileSync(userEnv.OPENCODE_CONFIG, 'utf8')), { ...contribution, plugins: ['-opencode.browser', '/contract/plugin'] });
    assert.deepEqual(JSON.parse(userEnv.OPENCODE_CONFIG_CONTENT), { model: 'user/model', experimental: { policies: [userPolicy] } });

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

  'deep-link-registry-call-site': () => {
    const main = source('packages/electron/main.mjs');
    has(main, /const dispatchDeepLink = async \(link\) => \{\n  if \(!link\) return;\n  if \(await deepLinkRegistry\.dispatch\(link\)\) return;\n/, 'dispatchDeepLink is no longer async with the registry as its first statement after the null guard');
    assert.equal(main.match(/dispatchDeepLink\(/g).length, 2, 'dispatchDeepLink gained or lost a caller');
    assert.equal(main.match(/void dispatchDeepLink\(/g).length, 2, 'a caller of dispatchDeepLink no longer discards the promise explicitly');
    assert.equal(main.match(/deepLinkRegistry\.dispatch\(/g).length, 1, 'the registry has more than one call site');
    for (const host of ['connect', 'focus', 'session', 'host']) {
      has(main, new RegExp(`link\\.type === '${host}'`), `upstream no longer dispatches the ${host} deep-link host, so the registry's reserved list is stale`);
    }
    has(main, /const deepLinkRegistry = createDeepLinkRegistry\(\{/);
    has(main, /import \{ createDeepLinkRegistry \} from '\.\/deep-link-registry\.mjs';/);
  },

  'plugin-host-option': async () => {
    const main = source('packages/electron/main.mjs');
    has(main, /import \{[^}]*\bsafeStorage\b[^}]*\} from 'electron';/, 'main.mjs no longer imports safeStorage from electron');
    has(main, /import \{ createSafeStorageSecretStore \} from '\.\/secret-store\.mjs';/);
    const start = main.indexOf('await startWebUiServer({');
    assert.ok(start >= 0, 'main.mjs no longer calls startWebUiServer with an options object');
    const call = main.slice(start, main.indexOf('\n  });', start));
    has(call, /pluginHost: \{\s*secretStore: createSafeStorageSecretStore\(\{ safeStorage \}\),\s*deepLinks: \{ register: deepLinkRegistry\.register \},\s*\},/, 'startWebUiServer no longer receives pluginHost');
    const asked = [];
    const probe = new Proxy({}, { get: (_target, name) => () => { asked.push(String(name)); return true; } });
    const { createSafeStorageSecretStore } = await importUpstream('packages/electron/secret-store.mjs');
    const store = createSafeStorageSecretStore({ safeStorage: probe });
    assert.deepEqual(asked, [], 'the shell secret store asks safeStorage while it is created, which can block the app behind a keychain dialog');
    assert.equal(typeof store.available, 'function', 'the shell secret store no longer exposes available(), so the server cannot ask lazily whether it can seal');
    assert.equal(store.available(), true);
    const clock = { at: 0 };
    const keychain = { answer: false, isEncryptionAvailable: () => keychain.answer };
    const late = createSafeStorageSecretStore({ safeStorage: keychain, now: () => clock.at });
    assert.equal(late.available(), false);
    keychain.answer = true;
    clock.at += 5_000;
    assert.equal(late.available(), true, 'the shell secret store keeps a no for the whole run, so a keychain prompt answered late needs a restart');
    has(source('packages/web/server/index.js'), /host: options\.pluginHost \?\? null,/, 'the plugin context no longer reads options.pluginHost into host');
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

  'models-metadata-disabled-env': () => {
    const routes = source('packages/web/server/lib/opencode/openchamber-routes.js');
    has(routes, /app\.get\('\/api\/openchamber\/models-metadata', async \(_req, res\) => \{\s*if \(isModelsMetadataDisabled\(process\.env\)\) \{\s*res\.json\(\{\}\);\s*return;\s*\}/, 'the models metadata route no longer answers an empty catalog before fetching models.dev when switched off');
    has(routes, /env\.OPENCHAMBER_MODELS_METADATA_DISABLED/, 'the models metadata switch is no longer read from OPENCHAMBER_MODELS_METADATA_DISABLED');
    for (const flavor of ['dev', 'prod']) {
      assert.equal(JSON.parse(source(`brand/product.${flavor}.json`)).env.OPENCHAMBER_MODELS_METADATA_DISABLED, '1', flavor);
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

  'plugin-routes-behind-api-auth': (t) => {
    const server = source('packages/web/server/index.js');
    const baseRoutes = server.indexOf('const bootstrapResult = bootstrapRuntime.setupBaseRoutes(app, {');
    const plugins = server.indexOf('serverPlugins = await loadServerPlugins(');
    assert.ok(baseRoutes >= 0 && plugins > baseRoutes, 'the server no longer sets up its base routes, API auth among them, before it loads plugins');
    has(source('packages/web/server/lib/opencode/bootstrap-runtime.js'), /registerAuthAndAccessRoutes\(app, \{/, 'the base routes no longer include auth and access');
    const core = source('packages/web/server/lib/opencode/core-routes.js');
    const access = core.slice(core.indexOf('export const registerAuthAndAccessRoutes = '), core.indexOf('export const registerSettingsUtilityRoutes = '));
    has(access, /app\.use\('\/api', async \(req, res, next\) => \{\s*try \{\s*await requireApiAuth\(req, res, next\);/, 'auth and access no longer guard every /api request');

    // On the real server, one fresh process per case (the server module
    // holds one server per process): a plugin's /api route answers without a
    // UI password and is refused without a session when one is set.
    const plugin = "export default (context) => { context.app.get('/api/contract-probe', (_req, res) => res.json({ reached: true })); };";
    const probeStatus = (uiPassword) => probeRealServer(t, plugin, { uiPassword, route: '/api/contract-probe' }).status;
    assert.equal(probeStatus(''), 200, 'the probe route is not reachable on an open server');
    assert.equal(probeStatus('contract-password'), 401, 'a plugin /api route answered without a UI session');
  },

  'non-api-json-body': (t) => {
    const core = source('packages/web/server/lib/opencode/core-routes.js');
    const common = core.slice(core.indexOf('export const registerCommonRequestMiddleware = '));
    has(common, /\} else if \(req\.path\.startsWith\('\/api'\)\) \{\s*next\(\);\s*\} else \{\s*express\.json\(\{ limit: '50mb' \}\)\(req, res, next\);\s*\}/, 'the server no longer parses JSON bodies outside /api');

    // On the real server, with a UI password set: a plugin route outside
    // /api is reached ahead of the app's own pages, with no UI session, and
    // gets its JSON body parsed.
    const plugin = "export default (context) => { context.app.post('/contract-json-probe', (req, res) => res.json({ received: req.body ?? null })); };";
    const sent = { model: 'm1', messages: [{ role: 'user', content: 'hi' }] };
    const { status, text } = probeRealServer(t, plugin, { uiPassword: 'contract-password', method: 'POST', route: '/contract-json-probe', body: sent });
    assert.equal(status, 200, text);
    assert.deepEqual(JSON.parse(text), { received: sent }, 'a plugin route outside /api no longer gets its JSON body parsed');
  },

  'product-deep-link-scheme': () => {
    for (const flavor of ['dev', 'prod']) {
      const product = JSON.parse(source(`brand/product.${flavor}.json`));
      assert.equal(product.env.MITTRCRAFT_DEEP_LINK_SCHEME, product.deepLinkProtocol, flavor);
    }
    has(source('packages/electron/early-startup.mjs'), /^export const DEEP_LINK_PROTOCOL = PRODUCT\.deepLinkProtocol;$/m, 'the shell no longer takes its URL scheme from the product');
    has(source('packages/electron/main.mjs'), /app\.setAsDefaultProtocolClient\(DEEP_LINK_PROTOCOL\);/, 'the shell no longer registers the product URL scheme');
  },

  'deep-link-raw': () => {
    const main = source('packages/electron/main.mjs');
    has(main, /const parseDeepLink = \(raw\) => \{[\s\S]{0,200}const trimmed = raw\.trim\(\);[\s\S]{0,500}return \{ type, value, raw: trimmed \};/, 'a parsed deep link no longer carries the URL it came from as raw');
    has(main, /if \(await deepLinkRegistry\.dispatch\(link\)\) return;/, 'registered handlers no longer receive the parsed link');
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

  'ui-root-wrapper': () => {
    const { entries } = item('ui-root-wrapper');
    for (const [file, { surface: name, app }] of Object.entries(entries)) {
      const text = source(file);
      has(text, /^import \{ ProductRoot \} from '(\.\/lib|@\/lib)\/product-plugins';?$/m, `${file} no longer imports ProductRoot`);
      const wrapped = new RegExp(`<SessionAuthGate>\\s*<ProductRoot surface="${name}">\\s*${app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</ProductRoot>\\s*</SessionAuthGate>`);
      has(text, wrapped, `${file} no longer renders the app inside <ProductRoot surface="${name}"> within SessionAuthGate`);
      assert.equal(lineCount(text, '<ProductRoot'), 1, `${file} renders ProductRoot more than once`);
    }

    const plugins = source('packages/ui/src/lib/product-plugins.ts');
    for (const name of ['ProductRoot', 'ProductSlot', 'useProductModelPicker', 'translateProductMessageError']) {
      has(plugins, new RegExp(`^export function ${name}\\b`, 'm'), `product-plugins no longer exports ${name}`);
    }
  },

  'desktop-bridge-listen': () => {
    const preload = source('packages/electron/preload.mjs');
    has(preload, /^ {2}listen: async \(event, handler\) => addListener\(event, handler\),$/m, 'the desktop bridge no longer exposes listen(event, handler)');
    has(preload, /contextBridge\.exposeInMainWorld\('__OPENCHAMBER_DESKTOP__', desktopBridge\);/, 'the desktop bridge is no longer __OPENCHAMBER_DESKTOP__');
    has(preload, /ipcRenderer\.on\('openchamber:emit', \(_evt, payload\) => \{[\s\S]{0,400}dispatchNativeEvent\(event, payload\.detail\);/, 'preload no longer hands openchamber:emit to its listeners');
    has(preload, /listener\(\{ payload: detail \}\);/, 'a listener is no longer called for its event');

    const main = source('packages/electron/main.mjs');
    has(main, /browserWindow\.webContents\.send\('openchamber:emit', \{ event, detail \}\);/, 'main no longer sends openchamber:emit');
    has(main, /const deepLinkRegistry = createDeepLinkRegistry\(\{\n  onEmit: \(event\) => \{[\s\S]{0,400}emitToAllWindows\(event, \{\}\);\n  \},/, 'the event a deep-link handler asks for no longer reaches every window');
  },

  'sign-in-gate-ui': () => {
    has(source('packages/ui/src/lib/runtime-fetch.ts'), /^export const runtimeFetch = async \(rawInput: string \| URL \| Request, init: RuntimeFetchOptions = \{\}\): Promise<Response> =>/m);
    has(source('packages/ui/src/lib/url.ts'), /^export const openExternalUrl = \(url: string\): Promise<boolean> =>\n  isExternalHttpUrl\(url\) \? openValidatedExternalUrl\(url\) : Promise\.resolve\(false\);$/m, 'openExternalUrl no longer opens only web addresses');
    const button = source('packages/ui/src/components/ui/button.tsx');
    has(button, /^export \{ Button \}$/m);
    for (const size of ['default', 'lg']) has(button, new RegExp(`^\\s+${size}: "`, 'm'), `Button lost the ${size} size`);
    for (const file of ['packages/ui/src/main.tsx', 'packages/ui/src/apps/renderElectronMiniChatApp.tsx']) {
      const text = source(file);
      const provider = text.indexOf('<I18nProvider>');
      const root = text.indexOf('<ProductRoot');
      assert.ok(provider >= 0 && root > provider && text.indexOf('</I18nProvider>') > root, `${file} no longer renders ProductRoot inside I18nProvider`);
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

  'opencode-user-config-io': async (t) => {
    const configFileFor = (env) => {
      const home = tempDir(t, 'contract-home-');
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCODE_|XDG_)/.test(name)));
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', 'const { CONFIG_FILE } = await import(process.env.CONTRACT_SHARED_URL); console.log(JSON.stringify(CONFIG_FILE));'], {
        encoding: 'utf8',
        env: { ...inherited, HOME: home, ...env, CONTRACT_SHARED_URL: pathToFileURL(path.join(repoRoot, 'packages/web/server/lib/opencode/shared.js')).href },
      });
      assert.equal(result.status, 0, result.stderr);
      return { home, file: JSON.parse(result.stdout.trim().split('\n').at(-1)) };
    };
    const dir = tempDir(t, 'contract-config-dir-');
    assert.equal(configFileFor({ OPENCODE_CONFIG_DIR: ` ${dir} ` }).file, path.join(dir, 'opencode.json'), 'CONFIG_FILE no longer follows OPENCODE_CONFIG_DIR');
    assert.equal(configFileFor({ XDG_CONFIG_HOME: dir }).file, path.join(dir, 'opencode', 'opencode.json'), 'CONFIG_FILE no longer falls back to XDG_CONFIG_HOME/opencode, the folder the engine gets');
    const fallback = configFileFor({});
    assert.equal(fallback.file, path.join(fallback.home, '.config', 'opencode', 'opencode.json'));

    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'error', () => {});
    const { readConfigFile, writeConfig } = await importUpstream('packages/web/server/lib/opencode/shared.js');
    const file = path.join(tempDir(t, 'contract-user-config-'), 'opencode', 'opencode.json');
    assert.deepEqual(readConfigFile(file), {}, 'a missing user config no longer reads as {}');
    writeConfig({ model: 'mittr/a1' }, file);
    assert.deepEqual(readConfigFile(file), { model: 'mittr/a1' }, 'writeConfig no longer creates the folder and the file');

    fs.writeFileSync(file, '{\n  // the person\'s own note\n  "model": "mittr/a1",\n  "theme": "dark"\n}\n');
    const config = readConfigFile(file);
    delete config.model;
    writeConfig(config, file);
    assert.deepEqual(readConfigFile(file), { theme: 'dark' });
    has(fs.readFileSync(file, 'utf8'), /\/\/ the person's own note/, 'writeConfig no longer keeps the comments in a config it edits');

    const broken = '{ "model": "mittr/a1", ';
    fs.writeFileSync(file, broken);
    assert.throws(() => readConfigFile(file), 'a user config that cannot be parsed no longer throws on read');
    assert.throws(() => writeConfig({ model: 'mittr/a2' }, file), 'writeConfig no longer refuses a config it cannot parse');
    assert.equal(fs.readFileSync(file, 'utf8'), broken);

    const server = source('packages/web/server/index.js');
    has(server, /import \{\s*CONFIG_FILE as OPENCODE_USER_CONFIG_FILE,\s*readConfigFile as readOpenCodeConfigFile,\s*writeConfig as writeOpenCodeConfig,\s*\} from '\.\/lib\/opencode\/shared\.js';/);
    has(pluginContext(server), /opencode: \{[^]*?userConfig: \{\s*path: OPENCODE_USER_CONFIG_FILE,\s*read: \(\) => readOpenCodeConfigFile\(OPENCODE_USER_CONFIG_FILE\),\s*write: \(config\) => writeOpenCodeConfig\(config, OPENCODE_USER_CONFIG_FILE\),\s*\},/, 'the plugin context no longer hands plugins the user config as opencode.userConfig');
  },

  'engine-integration-connect-key': () => {
    const dist = path.join(repoRoot, 'node_modules/@opencode/client/dist/chunks');
    const chunks = fs.readdirSync(dist).filter((name) => name.endsWith('.js')).map((name) => fs.readFileSync(path.join(dist, name), 'utf8'));
    const route = /connect: \{\s*key: \(input, requestOptions\) => request\(\{\s*method: "POST",\s*path: `\/api\/integration\/\$\{encodeURIComponent\(input\.integrationID\)\}\/connect\/key`,\s*query: \{ location: input\["location"\] \},\s*body: \{ key: input\["key"\], answer: input\["answer"\], label: input\["label"\] \},\s*successStatus: 204,\s*declaredStatuses: \[400, 401, 404\],/;
    assert.equal(chunks.filter((text) => route.test(text)).length, 1, 'the generated client no longer posts { key } to /api/integration/{id}/connect/key with 204 and a declared 404');
  },

  'engine-credential-list-remove': async () => {
    const dist = path.join(repoRoot, 'node_modules/@opencode/client/dist/chunks');
    const chunks = fs.readdirSync(dist).filter((name) => name.endsWith('.js')).map((name) => fs.readFileSync(path.join(dist, name), 'utf8'));
    const list = /credential: \{\s*list: \(requestOptions\) => request\(\{ method: "GET", path: `\/api\/credential`, successStatus: 200,[^}]*\}, requestOptions\)\.then\(\(value\) => value\.data\),/;
    const remove = /remove: \(input, requestOptions\) => request\(\{\s*method: "DELETE",\s*path: `\/api\/credential\/\$\{encodeURIComponent\(input\.credentialID\)\}`,\s*successStatus: 204,/;
    assert.equal(chunks.filter((text) => list.test(text) && remove.test(text)).length, 1, 'the generated client no longer lists credentials under data or removes one with DELETE /api/credential/{id}');
    const { Credential } = await import(pathToFileURL(path.join(repoRoot, 'node_modules/@opencode/schema/dist/credential.js')).href);
    assert.deepEqual(Object.keys(Credential.Entry.fields).sort(), ['active', 'id', 'integrationID', 'label', 'value']);
    assert.deepEqual(Object.keys(Credential.Key.fields).sort(), ['configuration', 'key', 'metadata', 'type']);
  },

  'model-controls-product-picker': () => {
    const controls = source('packages/ui/src/components/chat/ModelControls.tsx');
    has(controls, /^import \{ useProductModelPicker \} from '@\/lib\/product-plugins';$/m, 'ModelControls no longer imports useProductModelPicker');
    assert.equal(lineCount(controls, 'useProductModelPicker('), 1, 'ModelControls must call useProductModelPicker exactly once');
    has(controls, /const productModelPicker = useProductModelPicker\(agentMenuOpen \|\| activeMobilePanel === 'model'\);/, 'the picker decorations no longer follow whether the desktop list or the mobile sheet is open');
    has(controls, /const isProductModelAllowed = React\.useCallback\(\s*\(providerID: string\) => productModelPicker\.isProviderShown\(providerID\),/);
    assert.equal(lineCount(controls, '<ModelPickerList'), 1, 'ModelControls renders another ModelPickerList');
    const list = controls.slice(controls.indexOf('<ModelPickerList'), controls.indexOf('/>', controls.indexOf('maxHeightClassName=', controls.indexOf('<ModelPickerList'))));
    assert.ok(list.includes('isModelAllowed={isProductModelAllowed}'), 'the desktop picker list no longer gets isModelAllowed from the product picker');
    assert.equal(lineCount(controls, 'isProductModelAllowed('), 4, 'the mobile sheet no longer filters its providers, favorites and recents, or the Auto entry no longer follows the product picker');

    const picker = source('packages/ui/src/components/model-picker/ModelPickerList.tsx');
    has(picker, /isModelAllowed\?: \(providerID: string, modelID: string\) => boolean;/);
    assert.equal(lineCount(picker, 'if (isModelAllowed && !isModelAllowed('), 3, 'ModelPickerList no longer applies isModelAllowed to favorites, recents and providers');

    has(source('packages/ui/src/lib/product-plugins.ts'), /^export function useProductModelPicker\(open: boolean\): ModelPickerDecorations \{/m);
  },

  'model-picker-blocked-entry': () => {
    const picker = source('packages/ui/src/components/model-picker/ModelPickerList.tsx');
    has(picker, /isEntryBlocked\?: \(entry: ModelPickerEntry\) => boolean;/, 'ModelPickerList no longer takes isEntryBlocked');
    has(picker, /const blocked = isEntryBlocked\?\.\(entry\) \?\? false;/, 'a row no longer asks whether its entry is blocked');
    has(picker, /aria-disabled=\{disabled \|\| blocked \|\| undefined\}\s*tabIndex=\{-1\}\s*onClick=\{\(\) => \{ if \(!disabled && !blocked\) onSelect\(entry\); \}\}/, 'a blocked row is no longer aria-disabled or still answers a click');
    has(picker, /if \(disabled \|\| blocked \|\| event\.target !== event\.currentTarget\) return;\s*if \(event\.key === 'Enter' \|\| event\.key === ' '\) \{\s*event\.preventDefault\(\);\s*onSelect\(entry\);/, 'a blocked row still answers Enter or Space');
    has(picker, /else if \(activeEntry && !isEntryBlocked\?\.\(activeEntry\)\) onSelect\(activeEntry\);/, 'Enter in the search field can still choose a blocked entry');
    assert.equal(lineCount(picker, 'onSelect(entry)'), 2, 'ModelPickerList chooses an entry somewhere the blocked check does not cover');
    assert.equal(lineCount(picker, 'onSelect(activeEntry)'), 1, 'ModelPickerList chooses the highlighted entry somewhere the blocked check does not cover');

    const controls = source('packages/ui/src/components/chat/ModelControls.tsx');
    assert.equal(lineCount(controls, 'productModelPicker.entryStatus('), 1, 'ModelControls must ask the product picker for an entry status exactly once');
    has(controls, /const isEntryBlocked = \(entry: ModelPickerEntry\) => entryStatusOf\(entry\)\?\.blocked === true;/, 'the blocked check no longer follows the entry status');
    has(controls, /<ModelEntryStatusPill status=\{entryStatusOf\(entry\)\} isHighlighted=\{state\.isHighlighted\} \/>\s*\{renderThinkingSlot\(entry, state\)\}/, 'the row end is no longer the status pill followed by the thinking slot');
    assert.equal(lineCount(controls, 'renderRowEnd={renderRowEnd}'), 1, 'the desktop picker list no longer gets the composed row end');
    assert.equal(lineCount(controls, 'isEntryBlocked={isEntryBlocked}'), 1, 'the desktop picker list no longer gets isEntryBlocked');
    has(controls, /const mobileEntryStatus = entryStatusOf\(mobileEntry\);\s*const mobileEntryBlocked = isEntryBlocked\(mobileEntry\);/, 'the mobile sheet row no longer takes its status and blocked check from the same helpers');
    has(controls, /onClick=\{\(\) => handleMobileModelApply\(providerId, modelId, resolvedVariant\)\}\s*disabled=\{mobileEntryBlocked\}\s*aria-disabled=\{mobileEntryBlocked \|\| undefined\}/, 'a blocked entry can be applied from the mobile sheet row');
    has(controls, /onClick=\{\(\) => handleMobileModelApply\(providerId, modelId, variantOption\)\}\s*disabled=\{mobileEntryBlocked\}\s*aria-disabled=\{mobileEntryBlocked \|\| undefined\}/, 'a blocked entry can be applied from the mobile sheet effort buttons');
    has(controls, /onClick=\{\(\) => openMobileVariantOverflow\(providerId, modelId\)\}\s*disabled=\{mobileEntryBlocked\}/, 'a blocked entry can be applied from the mobile effort panel');
    assert.equal(lineCount(controls, 'handleMobileModelApply(providerId, modelId'), 2, 'the mobile sheet applies a model somewhere the blocked check does not cover');
    has(controls, /<ModelEntryStatusPill status=\{mobileEntryStatus\} isHighlighted=\{false\} \/>/, 'the mobile sheet row no longer draws the status pill');

    has(source('packages/ui/src/components/model-picker/ModelEntryStatusPill.tsx'), /aria-label=\{status\.title \?\? status\.pill\}/, 'the status pill lost its aria-label');
    has(source('packages/ui/src/lib/product-plugins.ts'), /^export type ModelEntryStatus = \{ pill: string; title\?: string; tone: 'neutral' \| 'near'; blocked: boolean \};$/m, 'ModelEntryStatus changed shape');
  },

  'providers-page-slot': () => {
    const grid = source('packages/ui/src/components/sections/providers/ProviderGrid.tsx');
    has(grid, /^import \{ ProductSlot \} from '@\/lib\/product-plugins';$/m, 'ProviderGrid no longer imports ProductSlot');
    assert.equal(lineCount(grid, '<ProductSlot '), 1, 'ProviderGrid renders ProductSlot more than once, or not at all');
    const view = grid.slice(grid.indexOf('export const ProviderGrid'));
    const layout = view.indexOf('<SettingsPageLayout');
    const slot = view.indexOf('<ProductSlot name="providers-page" />');
    const cards = view.indexOf('<div className={SETTINGS_CARD_GRID_CLASS}>');
    assert.ok(layout >= 0 && slot > layout && cards > slot, 'the providers-page slot is no longer inside the page layout, above the provider cards');
    has(source('packages/ui/src/components/sections/providers/ProvidersPage.tsx'), /if \(!selectedProvider\) \{\s*return \(\s*<ProviderGrid/, 'the providers page no longer opens on the provider grid');
    has(source('packages/ui/src/lib/product-plugins.ts'), /'providers-page': Record<never, never>;/);
  },

  'provider-switch-ui': () => {
    const control = source('packages/ui/src/components/ui/switch.tsx');
    has(control, /^export \{ Switch \};$/m);
    has(control, /import \{ Switch as BaseSwitch \} from '@base-ui\/react\/switch';/, 'Switch is no longer the base-ui switch, whose checked and onCheckedChange we pass');
    has(control, /loading\?: boolean;/);
    has(control, /aria-busy=\{loading \|\| undefined\}/);
    const section = source('packages/ui/src/components/sections/shared/SettingsSection.tsx');
    has(section, /^export const SettingsFieldRow: React\.FC<SettingsFieldRowProps> = \(\{/m);
    has(section, /interface SettingsFieldRowProps \{\s*label: React\.ReactNode;\s*description\?: React\.ReactNode;/);
  },

  'policy-schema': () => {
    has(source('node_modules/@opencode/schema/dist/config/experimental.js'), /policies: ConfigPolicy\.Info\.pipe\(Schema\.Array, optional\)/, 'experimental.policies is no longer a list of policies');
    const policy = source('node_modules/@opencode/schema/dist/config/policy.js');
    has(policy, /action: Schema\.Literals\(\[[^\]]*"provider\.use"[^\]]*\]\)/, 'a policy action can no longer be provider.use');
    has(policy, /resource: Schema\.String,/);
    has(policy, /export const Effect = Schema\.Literals\(\["allow", "deny"\]\);/);
  },

  'model-controls-add-provider-row': () => {
    const controls = source('packages/ui/src/components/chat/ModelControls.tsx');
    has(controls, /\{!selection && productModelPicker\.offersAddProvider !== false && <div[^>]*>\s*<button\s+type="button"\s+onClick=\{openAddProviderSettings\}/, 'the add-provider row no longer follows the picker decorations');
    assert.equal(lineCount(controls, 'onClick={openAddProviderSettings}'), 1, 'ModelControls offers another add-provider entry');
    has(source('packages/ui/src/lib/product-plugins.ts'), /offersAddProvider: first\.offersAddProvider !== false && second\.offersAddProvider !== false,/, 'composed picker decorations no longer withhold the add-provider row when one plugin does');
    has(source('packages/mittr-ui/src/providers/useMittrPickerFilter.ts'), /offersAddProvider: showOtherProviders,/);
  },

  'ui-remote-model-catalog': () => {
    const plugins = source('packages/ui/src/lib/product-plugins.ts');
    has(plugins, /remoteModelCatalog\?: boolean;/, 'a product plugin can no longer turn the remote model catalog off');
    has(plugins, /export function remoteModelCatalogAllowed\(\): boolean \{\s*return plugins\.every\(\(plugin\) => plugin\.remoteModelCatalog !== false\);/);
    const logos = source('packages/ui/src/hooks/useProviderLogo.ts');
    has(logos, /providerId && remoteModelCatalogAllowed\(\) \? `https:\/\/models\.dev\/logos\/\$\{providerId\}\.svg` : null/, 'provider logos no longer ask whether the remote model catalog is allowed');
    assert.equal(lineCount(logos, 'models.dev/logos'), 1, 'another models.dev logo URL is built outside the remote-catalog check');
    const store = source('packages/ui/src/stores/useConfigStore.ts');
    has(store, /const sources = remoteModelCatalogAllowed\(\) \? \[MODELS_DEV_PROXY_URL, MODELS_DEV_API_URL\] : \[MODELS_DEV_PROXY_URL\];/, 'the metadata load no longer skips models.dev when the remote catalog is off');
    assert.equal(lineCount(store, 'MODELS_DEV_API_URL'), 2, 'models.dev is fetched from another place in the config store');
    has(source('packages/mittr-ui/src/product-ui-plugin.tsx'), /remoteModelCatalog: false,/);
  },

  'engine-outbound-switches': (t) => {
    const { opencodeCli } = JSON.parse(source('packages/electron/package.json'));
    assert.equal(opencodeCli?.version, '2.0.22', 'the bundled engine moved: run the probe with --only outbound again, then update this pin');
    const binary = path.join(repoRoot, 'packages/electron/resources/opencode-cli/opencode');
    if (!fs.existsSync(binary)) {
      t.diagnostic('the engine binary is not prepared here, so only the pin is checked');
      return;
    }
    const bytes = fs.readFileSync(binary);
    for (const name of ['OPENCODE_DISABLE_MODELS_FETCH', 'OPENCODE_DISABLE_AUTOUPDATE']) {
      assert.ok(bytes.includes(`process.env.${name}`), `the bundled engine no longer reads ${name}, so it reaches a third party again`);
    }
  },

  'engine-share-config': () => {
    has(source('node_modules/@opencode/schema/dist/config.js'), /share: Schema\.Literals\(\["manual", "auto", "disabled"\]\)/, 'the engine config no longer takes share: "disabled"');
  },

  'engine-identity-hook': () => {
    const { opencodeCli } = JSON.parse(source('packages/electron/package.json'));
    assert.equal(opencodeCli?.version, '2.0.22', 'the bundled engine moved: run probe P3 again, then update the identity plugin and this pin');
  },

  'engine-launched-data-home': () => {
    const server = source('packages/web/server/index.js');
    has(pluginContext(server), /launchedDataHome: \(\) => openCodeLifecycleRuntime\.getManagedOpenCodeProcessEnv\(\)\?\.XDG_DATA_HOME \?\? null,/, 'the plugin context no longer reports the data folder the engine was launched with');

    const lifecycle = source('packages/web/server/lib/opencode/lifecycle.js');
    has(lifecycle, /getManagedOpenCodeProcessEnv: \(\) => \(state\.isExternalOpenCode \? null : managedProcessEnv\),/, 'the lifecycle no longer reports the managed process env, or reports one for an external server');
    has(lifecycle, /const processEnv = [^;]*\.\.\.managedOpenCodeEnv,[\s\S]*?managedProcessEnv = processEnv;\s*let serverInstance;[\s\S]*?env: processEnv,/, 'the recorded env is no longer the one the managed process is spawned with');
  },

  'engine-refresh-restarts': () => {
    const server = source('packages/web/server/index.js');
    has(pluginContext(server), /refresh: async \(reason\) => \{ await refreshOpenCodeAfterConfigChange\(reason\); \},/, 'the plugin context no longer refreshes the managed OpenCode');
    has(server, /const refreshOpenCodeAfterConfigChange = \(\.\.\.args\) => openCodeLifecycleRuntime\.refreshOpenCodeAfterConfigChange\(\.\.\.args\);/, 'index.js no longer refreshes through the lifecycle');

    const lifecycle = source('packages/web/server/lib/opencode/lifecycle.js');
    const start = lifecycle.indexOf('const refreshOpenCodeAfterConfigChange = async (reason');
    const end = lifecycle.indexOf('const bootstrapOpenCodeAtStartup', start);
    assert.ok(start >= 0 && end > start, 'the lifecycle no longer defines refreshOpenCodeAfterConfigChange before the startup bootstrap');
    const refresh = lifecycle.slice(start, end);
    has(refresh, /await restartOpenCode\(reason \|\| 'config-change'\);[\s\S]*await waitForOpenCodeReady\(\);/, 'a refresh no longer restarts the managed OpenCode and waits for it to be ready');
    has(lifecycle, /state\.openCodeProcess = await startOpenCode\(\);/, 'a managed restart no longer goes through startOpenCode, which reads the engine env');
  },

  'sidebar-footer-slot': () => {
    const footer = source('packages/ui/src/components/session/sidebar/shell/SidebarFooter.tsx');
    has(footer, /^import \{ ProductSlot \} from '@\/lib\/product-plugins';$/m, 'SidebarFooter no longer imports ProductSlot');
    assert.equal(lineCount(footer, '<ProductSlot '), 1, 'SidebarFooter renders ProductSlot more than once, or not at all');
    const runtime = footer.indexOf('{showRuntimeButtons ? (');
    const about = footer.indexOf("t('sessions.sidebar.footer.actions.aboutOpenChamber')");
    const slot = footer.indexOf('<ProductSlot name="sidebar-footer" />');
    const update = footer.indexOf('{showUpdateButton ? (');
    assert.ok(runtime >= 0 && about > runtime && slot > about && update > slot, 'the sidebar-footer slot is no longer after the runtime buttons and before the update button');
    has(source('packages/ui/src/lib/product-plugins.ts'), /'sidebar-footer': Record<never, never>;/);
  },

  'sidebar-footer-visible-on-desktop': () => {
    const footer = source('packages/ui/src/components/session/sidebar/shell/SidebarFooter.tsx');
    has(footer, /^ {2}showRuntimeButtons = true,$/m, 'the footer no longer shows its runtime buttons by default');
    has(footer, /if \(!showRuntimeButtons && !showUpdateButton\) \{\s*return null;\s*\}/, 'the footer now hides itself in another case');
    const sidebar = source('packages/ui/src/components/session/SessionSidebar.tsx');
    assert.equal(lineCount(sidebar, '<SidebarFooter'), 1, 'the session sidebar renders its footer more than once, or not at all');
    const start = sidebar.indexOf('<SidebarFooter');
    assert.ok(sidebar.slice(start, sidebar.indexOf('/>', start)).includes('showRuntimeButtons={!isVSCode}'), 'the session sidebar no longer shows the footer runtime buttons everywhere but VS Code');
  },

  'about-dialog-slot': () => {
    const dialog = source('packages/ui/src/components/ui/AboutDialog.tsx');
    has(dialog, /^import \{ ProductSlot \} from '@\/lib\/product-plugins';$/m, 'AboutDialog no longer imports ProductSlot');
    assert.equal(lineCount(dialog, '<ProductSlot '), 1, 'AboutDialog renders ProductSlot more than once, or not at all');
    const versions = dialog.indexOf("t('aboutDialog.openCodeVersionLabel'");
    const slot = dialog.indexOf('<ProductSlot name="about-dialog" />');
    const diagnostics = dialog.indexOf('{showDiagnostics && (');
    assert.ok(versions >= 0 && slot > versions && diagnostics > slot, 'the about-dialog slot is no longer under the version lines');
    has(source('packages/ui/src/App.tsx'), /<AboutDialog\s+open=\{isAboutDialogOpen\}/, 'the app no longer opens AboutDialog from the UI store');
    has(source('packages/ui/src/lib/product-plugins.ts'), /'about-dialog': Record<never, never>;/);
  },

  'about-settings-slot': () => {
    const page = source('packages/ui/src/components/sections/openchamber/AboutSettings.tsx');
    has(page, /^import \{ ProductSlot \} from '@\/lib\/product-plugins';$/m, 'AboutSettings no longer imports ProductSlot');
    assert.equal(lineCount(page, '<ProductSlot '), 1, 'AboutSettings renders ProductSlot more than once, or not at all');
    const desktop = page.indexOf('// Desktop layout');
    const updateError = page.lastIndexOf('{update.error && (');
    const slot = page.indexOf('<ProductSlot name="about-settings" />');
    const addresses = page.lastIndexOf("t('settings.openchamber.about.field.instanceUrls')");
    assert.ok(desktop >= 0 && updateError > desktop && slot > updateError && addresses > slot, 'the about-settings slot is no longer in the desktop layout between the update rows and the instance addresses');
    has(source('packages/ui/src/lib/product-plugins.ts'), /'about-settings': Record<never, never>;/);
  },

  'model-controls-auto-entry': () => {
    const controls = source('packages/ui/src/components/chat/ModelControls.tsx');
    has(controls, /const offeredAutoEntry = autoEntry && isProductModelAllowed\(autoEntry\.providerID\) \? autoEntry : null;/, 'the Auto entry no longer follows the picker decorations');
    assert.equal(lineCount(controls, 'leadingEntry={offeredAutoEntry}'), 1, 'the desktop picker no longer leads with the offered Auto entry');
    has(controls, /const mobileAutoEntry = offeredAutoEntry && /, 'the mobile sheet no longer offers only the offered Auto entry');
    assert.equal(controls.match(/\bautoEntry\b/g)?.length, 4, 'the Auto entry is used somewhere it does not follow the picker decorations');
    has(source('packages/ui/src/lib/routing/autoModel.ts'), /^export const AUTO_PROVIDER_ID = 'openchamber';$/m, 'the Auto sentinel provider moved');
    has(source('packages/mittr-ui/src/providers/useMittrPickerFilter.ts'), /isProviderShown: \(providerId\) => showOtherProviders \|\| providerId === MITTR_PROVIDER_ID,/);
  },

  'config-store-fresh-providers': () => {
    const store = source('packages/ui/src/stores/useConfigStore.ts');
    has(store, /^export const useConfigStore = create<ConfigStore>\(\)\(/m, 'useConfigStore is no longer a zustand store with getState');
    has(store, /loadProviders: \(options\?: \{ directory\?: string \| null; source\?: string; fresh\?: boolean \}\) => Promise<void>;/, 'loadProviders no longer takes fresh');
    has(store, /if \(existing && options\?\.fresh\) \{\s*await existing\.catch\(\(\) => undefined\);/, 'a fresh provider load no longer waits out the one in flight');
    has(store, /opencodeClient\.getProvidersForConfig\(fromDirectoryKey\(directoryKey\), \{ fresh: options\?\.fresh \}\)/, 'a fresh provider load no longer reaches the client as fresh');
    has(source('packages/ui/src/lib/opencode/client.ts'), /async getProvidersForConfig\(directory\?: string \| null, options\?: \{ fresh\?: boolean \}\): Promise<ProviderCatalog> \{[\s\S]{0,300}if \(existing && options\?\.fresh\) \{\s*await existing\.catch\(\(\) => undefined\)/, 'the client no longer waits out an in-flight provider read for a fresh one');
    has(source('packages/mittr-ui/src/providers/useMittrPickerFilter.ts'), /useConfigStore\.getState\(\)\.loadProviders\(\{ fresh: true, source: 'mittr:provider-lock' \}\)/);
  },

  'quota-provider-registry': async () => {
    const { registerQuotaProvider: registerRegistered } = await importUpstream('packages/web/server/lib/quota/providers/registered.js');
    const { registerQuotaProvider, fetchQuotaForProvider } = await importUpstream('packages/web/server/lib/quota/providers/index.js');
    assert.equal(typeof registerQuotaProvider, 'function', 'the quota provider registry no longer exports registerQuotaProvider');
    assert.doesNotMatch(source('packages/web/server/lib/quota/providers/registered.js'), /^import /m, 'registered.js imports something, so the server would load it (and its imports) at start');
    assert.equal(registerQuotaProvider, registerRegistered, 'the registry no longer takes its run-time providers from registered.js');
    const entry = { providerId: 'contract-probe', providerName: 'Probe', isConfigured: () => true, fetchQuota: async () => ({ providerId: 'contract-probe', ok: true }) };
    const unregister = registerQuotaProvider(entry);
    try {
      assert.equal((await fetchQuotaForProvider('contract-probe')).ok, true, 'a registered provider is no longer dispatched');
      assert.throws(() => registerQuotaProvider(entry), 'a second registration of one id no longer throws');
    } finally {
      unregister();
    }
    assert.equal((await fetchQuotaForProvider('contract-probe')).ok, false, 'unregistering no longer removes the provider');

    const { buildResult, toUsageWindow } = await importUpstream('packages/web/server/lib/quota/utils/formatters.js');
    const window = toUsageWindow({ usedPercent: 60, windowSeconds: 604800, resetAt: 1_760_000_000_000, valueLabel: '20 of 50 left' });
    assert.deepEqual(
      { used: window.usedPercent, remaining: window.remainingPercent, seconds: window.windowSeconds, resetAt: window.resetAt, label: window.valueLabel },
      { used: 60, remaining: 40, seconds: 604800, resetAt: 1_760_000_000_000, label: '20 of 50 left' },
    );
    const result = buildResult({ providerId: 'p', providerName: 'P', ok: true, configured: true, usage: { windows: { weekly: window } }, planLabel: 'plan' });
    assert.equal(result.planLabel, 'plan');
    assert.equal(result.usage.windows.weekly, window);
    assert.equal(buildResult({ providerId: 'p', providerName: 'P', ok: false, configured: true, error: 'x' }).error, 'x');

    const server = source('packages/web/server/index.js');
    has(pluginContext(server), /^\s+registerQuotaProvider,$/m, 'the server plugin context no longer hands plugins registerQuotaProvider');
    has(pluginContext(server), /^\s+quotaResult: \{ buildResult: buildQuotaResult, toUsageWindow \},$/m, 'the server plugin context no longer hands plugins the quota result helpers');
    has(server, /import \{ registerQuotaProvider \} from '\.\/lib\/quota\/providers\/registered\.js';/);
    has(server, /import \{ buildResult as buildQuotaResult, toUsageWindow \} from '\.\/lib\/quota\/utils\/formatters\.js';/);
  },

  'quota-ui-registry': () => {
    const registry = source('packages/ui/src/lib/quota/providers/index.ts');
    has(registry, /^export function registerQuotaProvider\(meta: \{ id: string; name: string \}, options\?: \{ first\?: boolean \}\): void \{/m, 'registerQuotaProvider is no longer exported with this signature');
    has(registry, /^export function selectRegisteredQuotaProvider\(id: string, select: \(id: QuotaProviderId\) => void\): void \{/m, 'selectRegisteredQuotaProvider is no longer exported with this signature');
    has(registry, /^export const QUOTA_PROVIDERS: QuotaProviderMeta\[\] = \[/m, 'QUOTA_PROVIDERS is no longer a mutable list');
    assert.doesNotMatch(registry, /useQuotaStore/, 'the registry imports the quota store, which imports the registry');
  },

  'quota-store-selection': () => {
    const store = source('packages/ui/src/stores/useQuotaStore.ts');
    has(store, /selectedProviderId: QuotaProviderId \| null;/, 'useQuotaStore no longer has selectedProviderId');
    has(store, /setSelectedProvider: \(providerId: QuotaProviderId \| null\) => void;/, 'useQuotaStore no longer has setSelectedProvider');
    has(source('packages/ui/src/components/sections/usage/UsagePage.tsx'), /if \(selectedProviderId\) \{\s*return;\s*\}/, 'the Usage page no longer leaves a chosen provider alone');
  },

  'settings-search-usage': () => {
    has(source('packages/ui/src/lib/settings/search.ts'), /id: 'usage\.model-quotas',\s*page: 'usage',\s*titleKey: 'settings\.usage\.page\.section\.modelQuotas',\s*keywords: \[[^\]]*'quota'/, 'the usage.model-quotas search item moved or lost its quota keyword');
    has(source('packages/ui/src/lib/settings/metadata.ts'), /slug: 'usage',[^}]*keywords: \[[^\]]*'quota'/, "the usage page's search keywords no longer include quota");
    has(source('packages/ui/src/lib/i18n/messages/en.settings.ts'), /'settings\.usage\.page\.section\.modelQuotas': /, 'the model quotas heading key is gone');
  },

  'chat-message-product-hooks': () => {
    const message = source('packages/ui/src/components/chat/ChatMessage.tsx');
    has(message, /^import \{ ProductSlot, translateProductMessageError \} from '@\/lib\/product-plugins';$/m, 'ChatMessage no longer imports ProductSlot and translateProductMessageError');
    assert.equal(lineCount(message, 'translateProductMessageError('), 1, 'ChatMessage asks for a product error text more than once, or not at all');
    const memo = message.indexOf('const assistantError = React.useMemo(');
    const asked = message.indexOf('translateProductMessageError({ type, message: errorText, status, responseBody: response?.body, providerID: message.info.providerID })');
    const upstreamText = message.indexOf('`Opencode failed to send message with error: ${detail}`');
    assert.ok(memo >= 0 && asked > memo && upstreamText > asked, 'the product error text is no longer asked for first in the assistantError memo');
    has(message, /const \{ type, message: errorText, status, response \} = message\.info\.error;\s*const productText = translateProductMessageError\([^)]*\);\s*if \(productText !== null\) \{\s*return \{ text: productText \};/, 'a product error text no longer replaces the error text');
    has(message, /errorMessage=\{assistantErrorText\}/, 'the error text no longer reaches MessageBody');
    assert.equal(lineCount(message, '<ProductSlot '), 1, 'ChatMessage renders ProductSlot more than once, or not at all');
    const slot = message.indexOf('<ProductSlot name="assistant-message-footer" message={message} isLatestTurn={turnGroupingContext?.isLatestTurn === true} />');
    const assistantBody = message.lastIndexOf('<MessageBody');
    const dialog = message.indexOf('<ToolOutputDialog');
    assert.ok(assistantBody >= 0 && slot > assistantBody && dialog > slot, 'the assistant-message-footer slot is no longer right under the assistant message body');
    has(message, /\) : \(\s*<div className="relative">\s*<MessageBody\s+sessionId=\{message\.info\.sessionID\}/, 'the last MessageBody is no longer the assistant branch');
    const plugins = source('packages/ui/src/lib/product-plugins.ts');
    has(plugins, /'assistant-message-footer': \{ message: \{ info: Message; parts: Part\[\] \}; isLatestTurn: boolean \};/);
    has(plugins, /type ProductMessageError = \{ type: string; message: string; status\?: number; responseBody\?: string; providerID\?: string \};/);
    has(plugins, /messageError\?: \(error: ProductMessageError\) => string \| null;/);
    has(source('node_modules/@opencode/client/dist/promise/generated/types.d.ts'), /export type SessionStructuredError = \{\s*type: string;\s*message: string;\s*status\?: number;\s*response\?: \{\s*body: string;\s*\};\s*\};/, 'the engine error no longer carries type, message, status and response.body');
  },

  'session-store-send-message': () => {
    const store = source('packages/ui/src/sync/session-ui-store.ts');
    const signature = /sendMessage: (?:async )?\(\s*content: string,\s*providerID: string,\s*modelID: string,\s*agent\?: string,\s*attachments\?: AttachedFile\[\],\s*agentMentionName\?: string,\s*additionalParts\?: Array<\{ text: string; attachments\?: AttachedFile\[\]; synthetic\?: boolean; [^>]*\}>,\s*variant\?: string,\s*inputMode\?: "normal" \| "shell",\s*options\?: SendMessageOptions,\s*\) =>/g;
    assert.equal(store.match(signature)?.length, 2, 'the store sendMessage no longer takes (content, providerID, modelID, agent, attachments, agentMentionName, additionalParts, variant, inputMode, options) in its type and its implementation');
    has(store, /type SendMessageOptions = \{[^}]*\bsessionId\?: string\s+directory\?: string/, 'SendMessageOptions no longer takes sessionId and directory');
    has(store, /const targetSessionId = capturedTarget\?\.sessionId \?\? options\?\.sessionId \?\? get\(\)\.currentSessionId/, 'sendMessage no longer sends to options.sessionId');
    has(store, /const files = attachments\?\.map\(\(a\) => \(\{\s*type: "file" as const,\s*mime: a\.mimeType,\s*url: a\.dataUrl,\s*filename: a\.filename,\s*\}\)\)/, 'attachments no longer travel as their dataUrl, mimeType and filename');
    has(store, /const contextItems = \(params\.additionalParts \?\? \[\]\)\s*\.filter\(\(part\) => part\.text\.trim\(\)\.length > 0\)/, 'additional parts no longer become context items');
    has(store, /const selection = resolveSendSelection\(params\.sessionId, requestDirectory, \{/, 'a send no longer switches the model and agent only when needed');
    has(store, /\/\/ Normal prompt — optimistic insert so message appears instantly\s*await optimisticSend\(\{/, 'a normal prompt is no longer inserted optimistically');
    has(source('packages/ui/src/lib/opencode/client.ts'), /for \(const item of context\) \{\s*await admitSynthetic\(item\)\s*\}[\s\S]{0,200}await prompt\(skills\.attached\)/, 'the context is no longer admitted right before the prompt');
    has(source('packages/ui/src/stores/types/sessionTypes.ts'), /export interface AttachedFile \{\s*id: string;\s*file: File;\s*dataUrl: string;\s*mimeType: string;\s*filename: string;\s*size: number;\s*source: "local" \| "server" \| "vscode";/, 'AttachedFile changed');
  },

  'quota-retry-turn-read': () => {
    const refs = source('packages/ui/src/sync/sync-refs.ts');
    has(refs, /export function getSyncMessages\(sessionId: string, directory\?: string\) \{\s*return getDirectoryState\(directory\)\?\.message\[sessionId\] \?\? \[\]/, 'getSyncMessages no longer reads the session messages');
    has(refs, /export function getSyncParts\(messageId: string, directory\?: string\) \{\s*return getDirectoryState\(directory\)\?\.part\[messageId\] \?\? \[\]/, 'getSyncParts no longer reads the message parts');
    has(source('packages/ui/src/sync/types.ts'), /^ {2}message: Record<string, Message\[\]>\n {2}part: Record<string, Part\[\]>$/m);
    const model = source('packages/ui/src/lib/opencode/model.ts');
    has(model, /export type SyntheticMessage = MessageBase & \{\s*role: "synthetic"\s*time: \{ created: number \}\s*text: string\s*description\?: string\s*\}/, 'SyntheticMessage changed');
    has(model, /export type FilePart = PartBase & \{\s*type: "file"\s*mime: string\s*filename\?: string\s*url: string\s*\}/, 'FilePart changed');
    has(model, /export type AgentPart = PartBase & \{\s*type: "agent"\s*name: string\s*\}/, 'AgentPart changed');
    has(model, /^ {2}agent: string\n {2}providerID: string\n {2}modelID: string\n {2}variant\?: string$/m, 'the assistant message no longer carries its agent, provider, model and variant');
    has(source('packages/ui/src/sync/session-ui-store.ts'), /^ {2}getDirectoryForSession: \(sessionId: string\) => string \| null$/m);
  },

  'quota-retry-button-ui': () => {
    const button = source('packages/ui/src/components/ui/button.tsx');
    has(button, /^ {8}outline:$/m, 'the Button outline variant is gone');
    has(button, /^ {8}xs: "/m, 'the Button xs size is gone');
    const sprite = source('packages/ui/src/components/icon/sprite.ts');
    for (const name of ['refresh', 'loader-4']) has(sprite, new RegExp(`^ {2}"${name}": `, 'm'), `the ${name} icon is gone`);
  },

  'answered-by-notice-ui': () => {
    has(source('packages/ui/src/components/icon/sprite.ts'), /^ {2}"arrow-left-right": /m, 'the arrow-left-right icon is gone');
    const model = source('packages/ui/src/lib/opencode/model.ts');
    const assistant = model.slice(model.indexOf('export type AssistantMessage = MessageBase & {'));
    has(assistant, /^ {2}time: \{\n {4}created: number\n(?: {4}.*\n)* {4}completed\?: number\n {2}\}\n {2}agent: string\n {2}providerID: string\n {2}modelID: string$/m, 'the assistant message no longer carries time.created, time.completed, providerID and modelID');
  },

  'quota-store-dropdown-providers': () => {
    const store = source('packages/ui/src/stores/useQuotaStore.ts');
    has(store, /^ {6}dropdownProviderIds: QUOTA_PROVIDERS\.map\(\(provider\) => provider\.id\),$/m, 'the store no longer starts from the registered providers');
    has(store, /const dropdownProviderIds = data\.usageDropdownProviders\s*\? data\.usageDropdownProviders\.filter\(/, 'a saved dropdown list is no longer filtered into a new list');
    has(store, /loadSettings: async \(\) => \{\s*const generation = quotaGeneration;\s*try \{\s*const settings = await loadSettingsFromRuntime\(\);\s*if \(generation !== quotaGeneration\) return;\s*set\(settings\);\s*\} catch/, 'loadSettings no longer sets the settings only after a read');
    has(store, /await get\(\)\.loadSettings\(\);/, 'the runtime load no longer reads loadSettings from the store');
    for (const file of ['packages/ui/src/hooks/useTraySync.ts', 'packages/ui/src/components/sections/usage/UsagePage.tsx', 'packages/ui/src/components/sections/usage/UsageSidebar.tsx', 'packages/ui/src/components/layout/Header.tsx']) {
      assert.doesNotMatch(source(file), /import \{[^}]*\bloadSettings\b[^}]*\} from '@\/stores\/useQuotaStore'/, `${file} imports a loadSettings that is not the store's`);
    }
    has(source('packages/ui/src/hooks/useTraySync.ts'), /useQuotaStore\.getState\(\)\.loadSettings\(\)/, 'the tray no longer loads the usage settings through the store');
    has(source('packages/ui/src/hooks/useTraySync.ts'), /if \(!dropdownProviderIds\.includes\(meta\.id\)\) continue;/, 'the tray no longer lists only the dropdown providers');
    has(source('packages/ui/src/components/usage/usageGroups.ts'), /\.filter\(\(providerMeta\) => dropdownProviderIds\.includes\(providerMeta\.id\)\)/, 'the work-status panel no longer lists only the dropdown providers');
    has(source('packages/ui/src/components/sections/usage/UsagePage.tsx'), /void updateDesktopSettings\(\{ usageDropdownProviders: next \}\);/, 'the Usage page no longer saves the dropdown list as usageDropdownProviders');
  },

  'account-menu-ui': () => {
    const menu = source('packages/ui/src/components/ui/dropdown-menu.tsx');
    for (const name of ['DropdownMenu', 'DropdownMenuContent', 'DropdownMenuItem', 'DropdownMenuLabel', 'DropdownMenuSeparator', 'DropdownMenuTrigger']) {
      has(menu, new RegExp(`^function ${name}\\(`, 'm'), `dropdown-menu no longer defines ${name}`);
      has(menu, new RegExp(`^\\s+${name},$`, 'm'), `dropdown-menu no longer exports ${name}`);
    }
    has(menu, /if \(!event\.defaultPrevented\) onSelect\?\.\(event\);/, 'a menu item no longer runs its click');
    const tooltip = source('packages/ui/src/components/ui/tooltip.tsx');
    for (const name of ['Tooltip', 'TooltipContent', 'TooltipTrigger']) has(tooltip, new RegExp(`^export \\{[^}]*\\b${name}\\b[^}]*\\}`, 'm'), `tooltip no longer exports ${name}`);
    const dialog = source('packages/ui/src/components/ui/dialog.tsx');
    has(dialog, /showCloseButton = true,/, 'DialogContent no longer lets the close button be left out');
    has(dialog, /\{showCloseButton && \(/);
    has(source('packages/ui/src/components/ui/index.ts'), /^export \{ toast \} from '\.\/toast'/m, 'toast is no longer exported from components/ui');
    const sprite = source('packages/ui/src/components/icon/sprite.ts');
    for (const name of ['check', 'user', 'loader']) has(sprite, new RegExp(`^ {2}"${name}": `, 'm'), `the ${name} icon is gone`);
    has(source('packages/ui/src/components/sections/shared/SettingsSection.tsx'), /^export const SETTINGS_FIELD_LABEL_CLASS =/m, 'SETTINGS_FIELD_LABEL_CLASS is no longer exported');
    const footerClass = source('packages/ui/src/components/session/sidebar/shell/SidebarFooter.tsx').match(/^const footerButtonClassName = '([^']+)';$/m)?.[1];
    assert.ok(footerClass, 'the sidebar footer no longer names its button classes in footerButtonClassName');
    const accountClass = source('packages/mittr-ui/src/accounts/MittrAccountMenu.tsx').match(/^const FOOTER_BUTTON_CLASS = '([^']+)';$/m)?.[1];
    assert.equal(accountClass, footerClass, 'the account button no longer wears the sidebar footer button classes');
  },

  'ui-auth-provider-registry': (t) => {
    const server = source('packages/web/server/index.js');
    has(server, /^import \{ createUiAuth, registerUiAuthProvider \} from '\.\/lib\/ui-auth\/ui-auth\.js';$/m);
    has(pluginContext(server), /uiAuth: \{\s*registerProvider: registerUiAuthProvider,\s*passwordEnabled: \(\) => typeof uiPassword === 'string' && uiPassword\.trim\(\)\.length > 0,\s*\},/, 'the plugin context no longer hands plugins the UI auth provider registry');
    has(server, /const uiPassword = typeof options\.uiPassword === 'string'\s*\? options\.uiPassword\s*: \(typeof process\.env\.OPENCHAMBER_UI_PASSWORD === 'string' \? process\.env\.OPENCHAMBER_UI_PASSWORD : null\);/, 'the server no longer reads the UI password where the plugin context sees it');
    has(source('packages/web/server/lib/opencode/bootstrap-runtime.js'), /createUiAuth\(\{\s*password: uiPassword,/, 'the UI auth controller no longer gets the same UI password');

    const script = `
      const { createUiAuth, registerUiAuthProvider } = await import(process.env.CONTRACT_UI_AUTH_URL);
      const response = () => {
        const res = { statusCode: 200, body: null, headers: {} };
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (body) => { res.body = body; return res; };
        res.type = () => res;
        res.send = (body) => { res.body = body; return res; };
        res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; return res; };
        res.getHeader = (name) => res.headers[name.toLowerCase()];
        return res;
      };
      const request = (cookie) => ({ method: 'GET', path: '/api/x', originalUrl: '/api/x', url: '/api/x', headers: cookie ? { cookie } : {} });
      const passes = async (auth, req) => { let passed = false; await auth.requireAuth(req, response(), () => { passed = true; }); return passed; };
      const auth = createUiAuth({});
      const before = await passes(auth, request());
      const provider = registerUiAuthProvider({ id: 'contract' });
      const enabledWhileRegistered = auth.enabled;
      const refused = response();
      await auth.requireAuth(request(), refused, () => {});
      const status = response();
      await auth.handleSessionStatus(request(), status);
      const issued = response();
      await provider.issueSession(request(), issued, { claims: { who: 'contract' } });
      const cookie = [].concat(issued.headers['set-cookie']).map((entry) => entry.split(';')[0]).join('; ');
      const withSession = await passes(auth, request(cookie));
      const claims = await provider.readClaims(request(cookie));
      const urlTokenResponse = response();
      await auth.handleUrlAuthToken({ method: 'POST', headers: { cookie }, body: {} }, urlTokenResponse);
      const urlToken = urlTokenResponse.body.token;
      const eventRequest = { method: 'GET', path: '/api/event', originalUrl: '/api/event?oc_url_token=' + urlToken, url: '/api/event?oc_url_token=' + urlToken, query: { oc_url_token: urlToken }, headers: {} };
      const urlTokenBefore = await passes(auth, eventRequest);
      const cleared = response();
      provider.clearSession(request(cookie), cleared);
      const urlTokenAfterSignOut = await passes(auth, eventRequest);
      const reset = response();
      auth.handleResetAuth(request(cookie), reset);
      const sessionAfterReset = await passes(auth, request(cookie));
      provider.unregister();
      const after = await passes(auth, request());
      const afterStatus = response();
      await auth.handleSessionStatus(request(), afterStatus);
      console.log(JSON.stringify({ before, enabledWhileRegistered, refused: { status: refused.statusCode, body: refused.body }, status: { code: status.statusCode, body: status.body }, withSession, claims, cleared: [].concat(cleared.headers['set-cookie'])[0], urlTokenBefore, urlTokenAfterSignOut, reset: reset.body, sessionAfterReset, after, afterStatus: afterStatus.body }));
    `;
    const { output } = runInTempHome(t, script, {
      CONTRACT_UI_AUTH_URL: pathToFileURL(path.join(repoRoot, 'packages/web/server/lib/ui-auth/ui-auth.js')).href,
    });
    assert.equal(output.before, true, 'a server without a UI password no longer lets requests through when no provider is registered');
    assert.equal(output.enabledWhileRegistered, true, 'the controller no longer reports itself enabled while a provider is registered, so sockets would skip auth');
    assert.deepEqual(output.refused, { status: 401, body: { error: 'UI authentication required', locked: true } });
    assert.deepEqual(output.status, { code: 401, body: { authenticated: false, locked: true, providers: ['contract'], passwordEnabled: false } });
    assert.equal(output.withSession, true, 'a provider session no longer opens the UI');
    assert.deepEqual(output.claims, { who: 'contract' });
    assert.match(output.cleared, /^oc_ui_session=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0/);
    assert.equal(output.urlTokenBefore, true);
    assert.equal(output.urlTokenAfterSignOut, false, 'signing out no longer revokes the URL tokens of that session');
    assert.deepEqual(output.reset, { cleared: true, clearedPasskeys: 0, signedOutEverywhere: true });
    assert.equal(output.sessionAfterReset, false, 'sign out everywhere no longer ends provider sessions on a server without a UI password');
    assert.equal(output.after, true, 'unregistering the last provider no longer gives back upstream behaviour');
    assert.deepEqual(output.afterStatus, { authenticated: true, disabled: true });

    const plugin = "export default (context) => { context.uiAuth.registerProvider({ id: 'contract' }); context.app.get('/contract-ui-auth-probe', (_req, res) => res.json({ passwordEnabled: context.uiAuth.passwordEnabled() })); context.app.get('/api/contract-ui-auth-probe', (_req, res) => res.json({ reached: true })); };";
    const session = probeRealServer(t, plugin, { route: '/auth/session' });
    assert.equal(session.status, 401);
    assert.deepEqual(JSON.parse(session.text), { authenticated: false, locked: true, providers: ['contract'], passwordEnabled: false });
    assert.equal(probeRealServer(t, plugin, { route: '/api/contract-ui-auth-probe' }).status, 401, 'a registered provider no longer guards /api on the real server');
    assert.deepEqual(JSON.parse(probeRealServer(t, plugin, { uiPassword: 'contract-password', route: '/contract-ui-auth-probe' }).text), { passwordEnabled: true });
    assert.deepEqual(JSON.parse(probeRealServer(t, plugin, { route: '/contract-ui-auth-probe' }).text), { passwordEnabled: false });
  },

  'server-cli-entry': () => {
    const cli = source('packages/web/bin/cli.js');
    has(cli, /^const isCliExecution = isModuleCliExecution\(process\.argv\[1\], import\.meta\.url, fs\.realpathSync, 'openchamber'\);$/m, 'cli.js no longer decides it runs by comparing argv[1] with its own path');
    has(source('packages/web/bin/cli-entry.js'), /if \(pathToFileURL\(normalizedEntryPath\)\.href === pathToFileURL\(normalizedModulePath\)\.href\) \{\s*return true;\s*\}/);
    assert.equal(JSON.parse(source('packages/web/package.json')).bin.openchamber, './bin/cli.js');
    const wrapper = source('packages/mittr-server/bin/mittrcraft.mjs');
    has(wrapper, /const SERVER_CLI = path\.resolve\(here, '\.\.', '\.\.', 'web', 'bin', 'cli\.js'\);/, 'the mittrcraft bin no longer points at the server CLI');
    has(source('packages/web/bin/lib/cli-args.js'), /uiPassword: process\.env\.OPENCHAMBER_UI_PASSWORD \|\| undefined,/, 'the CLI no longer reads OPENCHAMBER_UI_PASSWORD, the name the bin maps MITTRCRAFT_UI_PASSWORD onto');
    has(source('packages/web/server/lib/security/bind-host.js'), /env\?\.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN === 'true'/, 'the server no longer reads OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN');
    has(source('packages/web/server/index.js'), /process\.env\.OPENCHAMBER_DATA_DIR/, 'the server no longer reads OPENCHAMBER_DATA_DIR');
    has(source('packages/web/server/lib/server-plugins.js'), /const SERVER_PLUGINS_ENV = 'OPENCHAMBER_SERVER_PLUGINS';/);
    assert.ok(fs.existsSync(path.join(repoRoot, 'packages/mittr-server/bin', '..', '..', 'web', 'bin', 'cli.js')));
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

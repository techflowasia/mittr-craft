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
import { SERVER_ONLY_SECRETS } from './plugin.js';

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

  'git-remote-url': () => {
    const server = source('packages/web/server/index.js');
    has(server, /import \{ getRemoteUrl, resolvePrimaryWorktreeRoot \} from '\.\/lib\/git\/service\.js';/, 'index.js no longer imports getRemoteUrl from the git service');
    has(pluginContext(server), /git: \{ remoteUrl: \(directory\) => getRemoteUrl\(directory, 'origin'\) \},/, 'the plugin context no longer carries git.remoteUrl as the origin remote');
    has(source('packages/web/server/lib/git/service.js'), /export async function getRemoteUrl\(directory, remoteName = 'origin'\) \{\s*const git = await createGit\(directory\);\s*try \{\s*const url = await git\.remote\(\['get-url', '--', remoteName\]\);\s*return url\?\.trim\(\) \|\| null;\s*\} catch \{\s*return null;\s*\}\s*\}/, 'getRemoteUrl no longer answers the trimmed remote URL, or null on any failure');
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

    const tools = [
      `import { registerMittrToolsSettingsRoutes } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'packages/mittr-server/src/mittr/tools/settings-routes.js')).href)};`,
      'const view = async () => ({ computer: { offered: true, enabled: true }, chrome: { offered: true, chromeInstalled: true, enabled: true, profile: null, headed: false, approvedHosts: [] } });',
      'export default (context) => registerMittrToolsSettingsRoutes(context.app, {',
      '  express: context.express, host: context.host, requestScope: context.requestScope, view,',
      "  apply: async () => { throw new Error('applied'); }, profiles: async () => [], removeHost: async () => ['removed.example.test'],",
      '});',
    ].join('\n');
    const toolsProbe = (uiPassword, method, route, body) => probeRealServer(t, tools, { uiPassword, method, route, body });
    for (const [method, route, body] of [['GET', '/api/mittr/tools'], ['PUT', '/api/mittr/tools', { chrome: false }], ['DELETE', '/api/mittr/tools/chrome/approved-hosts/acme.example.test']]) {
      const refused = toolsProbe('contract-password', method, route, body);
      assert.equal(refused.status, 401, `an unauthenticated ${method} ${route} answered ${refused.status}`);
      assert.ok(!/offered|removed|applied|only on this Mac/.test(refused.text), `an unauthenticated ${method} ${route} reached the route`);
    }
    const open = toolsProbe('', 'GET', '/api/mittr/tools');
    assert.equal(open.status, 200, `the tools settings route is not reachable on an open server: ${open.text}`);
    assert.equal(JSON.parse(open.text).canChange, false, 'a web server with no desktop host says its tool settings can be changed');
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

  'plugin-context-mcp-entity': async () => {
    const server = source('packages/web/server/index.js');
    has(server, /^import \{ toMcpEntity \} from '\.\/lib\/opencode\/config-v2\.js';$/m, 'index.js no longer imports toMcpEntity from config-v2');
    has(pluginContext(server), /opencode: \{[^]*?mcpEntity: toMcpEntity,/, 'the plugin context no longer hands plugins toMcpEntity as opencode.mcpEntity');
    has(source('packages/web/server/lib/opencode/config-v2.js'), /^export \{[^}]*\btoMcpEntity,/m, 'config-v2 no longer exports toMcpEntity');

    const { toMcpEntity } = await importUpstream('packages/web/server/lib/opencode/config-v2.js');
    assert.deepEqual(
      toMcpEntity({ type: 'local', command: ['npx', '-y', 'acme-mcp'], environment: { ACME_KEY: 'k' }, enabled: false }),
      { type: 'local', command: ['npx', '-y', 'acme-mcp'], environment: { ACME_KEY: 'k' }, disabled: true },
      'a v1 local entry no longer becomes the v2 entry',
    );
    assert.deepEqual(
      toMcpEntity({ type: 'remote', url: ' https://acme.example/mcp ', headers: { authorization: 'Bearer k' }, oauth: { clientId: 'c' } }),
      { type: 'remote', url: 'https://acme.example/mcp', headers: { authorization: 'Bearer k' }, oauth: { client_id: 'c' } },
      'a v1 remote entry no longer becomes the v2 entry',
    );
    assert.deepEqual(toMcpEntity({ command: ['acme'] }), { type: 'local', command: ['acme'] }, 'an entry without a type no longer defaults to local, which catalogMcpEntity guards against');
  },

  'plugin-context-control': async (t) => {
    const server = source('packages/web/server/index.js');
    has(server, /^import \{ OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS, OPENCHAMBER_ALL_ACTIONS, OPENCHAMBER_WEB_ACTION_DEFINITIONS \} from '\.\/lib\/openchamber-control\/actions\.js';$/m, 'index.js no longer imports the agent tool and web action definitions');
    has(server, /^import \{ SCREENSHOT_DIRECTORY, writeScreenshot \} from '\.\/lib\/openchamber-control\/screenshots\.js';$/m, 'index.js no longer imports the screenshot writer');
    has(server, /^import \{ OpenChamberControlError \} from '\.\/lib\/openchamber-control\/error\.js';$/m, 'index.js no longer imports the control error class');
    has(server, /^const openChamberControlService = createOpenChamberControlService\(\{$/m, 'index.js no longer builds one control service');
    has(pluginContext(server), /control: \{\s*execute: openChamberControlService\.execute,\s*resolveSessionDirectory: openChamberControlService\.resolveSessionDirectory,\s*definitions: \(\) => \(\{ control: OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS, web: OPENCHAMBER_WEB_ACTION_DEFINITIONS \}\),\s*all: OPENCHAMBER_ALL_ACTIONS,\s*ControlError: OpenChamberControlError,\s*writeScreenshot,\s*SCREENSHOT_DIRECTORY,\s*\},/, 'the plugin context no longer hands plugins the control service, its definitions, its error class and the screenshot writer as control');

    const service = source('packages/web/server/lib/openchamber-control/service.js');
    has(service, /const execute = async \(action, input = \{\}, contextDirectory, options = \{\}\) => \{/, 'the control service execute no longer takes (action, input, contextDirectory, options)');
    has(service, /browserAction\(action, input, options\.signal, contextDirectory, options\.contextSessionId\)/, 'the control service no longer passes options.signal and options.contextSessionId to page actions');
    has(service, /return \{ execute, resolveSessionDirectory \};/, 'the control service no longer returns execute and resolveSessionDirectory');

    const actions = await importUpstream('packages/web/server/lib/openchamber-control/actions.js');
    const lists = { control: actions.OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS, web: actions.OPENCHAMBER_WEB_ACTION_DEFINITIONS };
    for (const [name, list] of Object.entries(lists)) {
      assert.ok(Array.isArray(list) && list.length > 0, `actions.js no longer exports the ${name} definitions`);
      for (const entry of list) {
        assert.ok(['action', 'title', 'description'].every((key) => entry[key] === String(entry[key]) && entry[key] !== ''), `a ${name} definition lost its action, title or description: ${JSON.stringify(entry)}`);
      }
    }
    assert.ok(lists.control.some(({ action }) => action === 'session.list') && lists.web.some(({ action }) => action === 'browser.open'), 'the definitions no longer hold session.list and browser.open');
    const all = actions.OPENCHAMBER_ALL_ACTIONS;
    assert.ok([...lists.control, ...lists.web].every(({ action }) => all.includes(action)), 'the full action list no longer holds every control and web definition');
    for (const action of ['schedule.status', 'memory.save', 'notify.send']) assert.ok(all.includes(action), `the full action list no longer holds ${action}`);
    has(service, /const CONTROL_ACTIONS = new Set\(OPENCHAMBER_ALL_ACTIONS\);/, 'the control service no longer runs exactly the full action list');

    const { createMittrActionRegistry } = await import('./mittr/tools/registry.js');
    const registry = createMittrActionRegistry({ control: { all } });
    registry.defineTool({ name: 'contract_probe', description: 'probe', parameters: { type: 'object' } });
    for (const action of all) {
      assert.throws(() => registry.register({ action, tool: 'contract_probe', title: 'T', description: 'D', effect: 'read', execute: async () => ({}) }), /is an upstream action/, `a Mittr action could take upstream's ${action}`);
    }
    const { setupMittr } = await import('./mittr/index.js');
    const { fakeEngineContext } = await import('./mittr/test-helpers.js');
    const express = (await import('express')).default;
    const quiet = { log: () => {}, warn: () => {}, error: () => {} };
    const mittr = setupMittr(
      { app: express(), express, dataDir: tempDir(t, 'contract-mittr-'), logger: quiet, host: null, ...fakeEngineContext().context },
      { env: {}, fetchImpl: async () => { throw new Error('no network in the contract'); } },
    );
    t.after(() => mittr.dispose());
    for (const { action } of mittr.registry.definitions({ includeVoiceOnly: true })) {
      assert.ok(!all.includes(action), `the Mittr action ${action} is an upstream action name`);
    }

    const screenshots = await importUpstream('packages/web/server/lib/openchamber-control/screenshots.js');
    assert.equal(screenshots.SCREENSHOT_DIRECTORY, path.join('.openchamber', 'screenshots'));
    const directory = tempDir(t, 'contract-shots-');
    const written = await screenshots.writeScreenshot({
      directory,
      base64: Buffer.from('acme').toString('base64'),
      mime: 'image/png',
      label: 'Before Fix',
      now: new Date('2026-10-21T01:02:03.456Z'),
    });
    const relative = '.openchamber/screenshots/before-fix-2026-10-21T01-02-03-456.png';
    assert.deepEqual(written, { path: relative, absolutePath: path.join(directory, relative) }, 'writeScreenshot no longer answers the project-relative and absolute paths it wrote');
    assert.equal(fs.readFileSync(written.absolutePath, 'utf8'), 'acme');

    const routes = source('packages/web/server/lib/openchamber-control/routes.js');
    has(routes, /req\.once\('aborted', abortOnDisconnect\);\s*res\.once\('close', abortOnDisconnect\);/, 'the control route no longer aborts the action when the request closes');
    has(routes, /\.\.\.\(controlError\.partial === true \? \{\s*partial: true,\s*partialAction: controlError\.partialAction,\s*sessionId: controlError\.sessionId,\s*directory: controlError\.directory,\s*\} : \{\}\),/, 'the control route no longer answers the partial-result fields');
    has(source('packages/web/server/lib/openchamber-control/error.js'), /Number\(error\?\.statusCode\) \|\| Number\(error\?\.status\) \|\| fallbackStatus/, 'asControlError no longer takes the status from statusCode, then status');
    const controlError = source('packages/web/server/lib/openchamber-control/error.js');
    has(controlError, /^export class OpenChamberControlError extends Error \{$/m, 'error.js no longer exports the control error class the plugin context hands over, which the route matches to keep partial-result fields');
    has(controlError, /if \(error instanceof OpenChamberControlError\) return error;/, 'asControlError no longer keeps the control error, partial fields and all, and rebuilds every other error');
    const { OpenChamberControlError, asControlError } = await importUpstream('packages/web/server/lib/openchamber-control/error.js');
    const kept = new OpenChamberControlError('x', 502, { partial: true });
    assert.equal(asControlError(kept, 'y'), kept, 'asControlError no longer hands back the control error itself');
    assert.ok(asControlError(new Error('z'), 'y') instanceof OpenChamberControlError, 'asControlError no longer rebuilds another error as the control error class');

    const tunnelAuth = source('packages/web/server/lib/opencode/tunnel-auth.js');
    has(tunnelAuth, /if \(activeTunnelHost && reqHost === activeTunnelHost\) \{\s*return 'tunnel';\s*\}\s*if \(isLocalHost\(reqHost, req\)\) \{\s*return 'local';\s*\}/, 'classifyRequestScope no longer answers tunnel for the tunnel host before local');

    const plugin = [
      `import { createMittrActionRegistry } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'packages/mittr-server/src/mittr/tools/registry.js')).href)};`,
      `import { registerMittrControlRoutes } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'packages/mittr-server/src/mittr/tools/control-routes.js')).href)};`,
      'export default (context) => {',
      '  const registry = createMittrActionRegistry({ control: context.control });',
      "  registry.defineTool({ name: 'acme_probe', description: 'probe', parameters: { type: 'object' } });",
      "  registry.register({ action: 'acme.ping', tool: 'acme_probe', title: 'Ping', description: 'Ping', effect: 'read', execute: async (_input, ctx) => ({ pong: true, scope: ctx.scope }) });",
      "  registry.register({ action: 'acme.partial', tool: 'acme_probe', title: 'Partial', description: 'Partial', effect: 'read', execute: async () => { throw new context.control.ControlError('half done', 502, { partial: true, partialAction: 'acme-made', sessionId: 'ses_acme', directory: '/acme' }); } });",
      '  registerMittrControlRoutes(context.app, { express: context.express, registry, host: context.host, requestScope: context.requestScope, ControlError: context.control.ControlError });',
      '};',
    ].join('\n');
    const probe = (uiPassword, action) => probeRealServer(t, plugin, { uiPassword, method: 'POST', route: '/api/mittr/control', body: { action } });
    const refused = probe('contract-password', 'acme.ping');
    assert.equal(refused.status, 401, `an unauthenticated /api/mittr/control answered ${refused.status}`);
    assert.ok(!refused.text.includes('pong'), 'an unauthenticated request ran the action');
    const open = probe('', 'acme.ping');
    assert.deepEqual({ status: open.status, body: JSON.parse(open.text) }, { status: 200, body: { pong: true, scope: { local: false } } }, 'an open server does not run a Mittr action through the real control context');
    const partial = probe('', 'acme.partial');
    assert.deepEqual({ status: partial.status, body: JSON.parse(partial.text) }, { status: 502, body: { error: 'half done', partial: true, partialAction: 'acme-made', sessionId: 'ses_acme', directory: '/acme' } }, 'the route no longer keeps the partial-result fields of the error class the real control context hands over');
    const upstream = probe('', 'projects.list');
    assert.equal(upstream.status, 200, `the real control service did not answer projects.list: ${upstream.text}`);
    assert.ok(Array.isArray(JSON.parse(upstream.text).projects), 'the real control service no longer answers projects.list with projects');
  },

  'mcp-user-layers': (t) => {
    has(source('packages/web/server/lib/opencode/shared.js'), /userPaths: \[\s*path\.join\(OPENCODE_CONFIG_DIR, 'opencode\.json'\),\s*path\.join\(OPENCODE_CONFIG_DIR, 'opencode\.jsonc'\),\s*\],/, 'the user config layers are no longer opencode.json and opencode.jsonc in the config folder');
    has(source('packages/web/server/lib/opencode/mcp.js'), /if \(!\/\^\[a-z0-9\]\[a-z0-9_-\]\*\[a-z0-9\]\$\|\^\[a-z0-9\]\$\/\.test\(name\)\) \{/, 'validateMcpName no longer allows exactly lowercase letters, digits, - and _ with a letter or digit at each end');

    const configDir = tempDir(t, 'contract-mcp-config-');
    fs.writeFileSync(path.join(configDir, 'opencode.json'), JSON.stringify({
      mcp: {
        servers: { 'mittr-acme': { type: 'remote', url: 'https://acme.example/mcp' }, mine: { type: 'local', command: ['acme-mcp'] } },
        'mittr/legacy': { type: 'local', command: ['old'] },
        timeout: 5,
      },
    }));
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCODE_|XDG_)/.test(name)));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', 'console.log = () => {}; const { listMcpConfigs } = await import(process.env.CONTRACT_MCP_URL); process.stdout.write(JSON.stringify(listMcpConfigs(undefined).map(({ name, scope, type }) => ({ name, scope, type })).sort((a, b) => a.name.localeCompare(b.name))));'], {
      encoding: 'utf8',
      env: { ...inherited, HOME: tempDir(t, 'contract-home-'), OPENCODE_CONFIG_DIR: configDir, CONTRACT_MCP_URL: pathToFileURL(path.join(repoRoot, 'packages/web/server/lib/opencode/mcp.js')).href },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      { name: 'mine', scope: 'user', type: 'local' },
      { name: 'mittr-acme', scope: 'user', type: 'remote' },
      { name: 'mittr/legacy', scope: 'user', type: 'local' },
    ], 'Settings → MCP no longer lists the user config\'s mcp.servers and typed v1 entries as user servers');
  },

  'managed-config-private': async (t) => {
    const managed = source('packages/web/server/lib/opencode/managed-config-file.js');
    has(managed, /await fsPromises\.writeFile\(tmp, text, \{ encoding: 'utf8', mode: 0o600 \}\);\s*await fsPromises\.rename\(tmp, filePath\);/, 'the managed config is no longer written 0600 through a temp file and a rename');
    has(source('packages/web/server/lib/opencode/shared.js'), /customPath: process\.env\.OPENCODE_CONFIG\s*\? path\.resolve\(process\.env\.OPENCODE_CONFIG\)\s*: null,/, 'Settings → MCP no longer takes its custom layer from the server\'s own OPENCODE_CONFIG');

    const { createManagedConfigRuntime, MANAGED_CONFIG_FILE_NAME } = await importUpstream('packages/web/server/lib/opencode/managed-config-file.js');
    assert.equal(MANAGED_CONFIG_FILE_NAME, 'opencode.managed.json', 'the managed file moved: the held-name check must not read it as the person\'s own OPENCODE_CONFIG');
    has(managed, /const userFile = path\.resolve\(env\.OPENCODE_CONFIG\.trim\(\)\);[\s\S]*?parseUserConfig\(env\.OPENCODE_CONFIG_CONTENT \?\? '', 'OPENCODE_CONFIG_CONTENT'\),/, 'the person\'s own OPENCODE_CONFIG and OPENCODE_CONFIG_CONTENT are no longer the layers handed to the engine beside the managed file');
    const dataDir = tempDir(t, 'contract-managed-private-');
    const env = {};
    const connector = { type: 'remote', url: 'https://acme.example/mcp', headers: { authorization: 'Bearer k' } };
    const runtime = createManagedConfigRuntime({ fsPromises: fs.promises, path, dataDir, env, readSettings: async () => ({}), isAgentMemoryAvailable: () => false, contributeConfig: async () => ({ mcp: { servers: { 'acme-x': connector } } }) });
    const childEnv = await runtime.buildManagedChildEnv();
    const file = path.join(dataDir, MANAGED_CONFIG_FILE_NAME);
    assert.equal(childEnv.OPENCODE_CONFIG, file);
    assert.equal(env.OPENCODE_CONFIG, undefined, 'the managed file is no longer handed to the child alone');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcp.servers['acme-x'], connector);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the managed config is no longer private');
    await runtime.refreshManagedConfigFile();
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'a managed config refresh is no longer private');
    assert.deepEqual(fs.readdirSync(dataDir), [MANAGED_CONFIG_FILE_NAME]);
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

  'integrations-page-slot': () => {
    const page = source('packages/ui/src/components/sections/integrations/IntegrationsPage.tsx');
    has(page, /^import \{ ProductSlot \} from '@\/lib\/product-plugins';$/m, 'IntegrationsPage no longer imports ProductSlot');
    assert.equal(lineCount(page, '<ProductSlot '), 1, 'IntegrationsPage renders ProductSlot more than once, or not at all');
    const layout = page.indexOf('<SettingsPageLayout');
    const builtIn = page.indexOf("title={t('settings.integrations.firstParty.title')}");
    const builtInEnd = page.indexOf('</SettingsSection>', builtIn);
    const slot = page.indexOf('<ProductSlot name="integrations-page" />');
    const thirdParty = page.indexOf('<ThirdPartyIntegrationsSection');
    assert.ok(layout >= 0 && builtIn > layout && builtInEnd > builtIn && slot > builtInEnd && thirdParty > slot, 'the integrations-page slot is no longer inside the page layout, right after the built-in integrations section and before the third-party integrations');
    has(page.slice(builtInEnd, slot), /^<\/SettingsSection>\s*\) : null\}\s*$/, 'something now sits between the built-in integrations section and the integrations-page slot');
    has(source('packages/ui/src/lib/product-plugins.ts'), /'integrations-page': Record<never, never>;/);
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

  'engine-ripgrep-bin': (t) => {
    const { opencodeCli } = JSON.parse(source('packages/electron/package.json'));
    assert.equal(opencodeCli?.version, '2.0.22', 'the bundled engine moved: read how it finds rg again, then update this pin');
    const binary = path.join(repoRoot, 'packages/electron/resources/opencode-cli/opencode');
    if (!fs.existsSync(binary)) {
      t.diagnostic('the engine binary is not prepared here, so only the pin is checked');
      return;
    }
    const text = fs.readFileSync(binary, 'latin1');
    assert.match(text, /\w+=process\.env\.XDG_CACHE_HOME\|\|/, 'the engine no longer takes its cache folder from XDG_CACHE_HOME');
    assert.match(text, /bin:\w+\.join\(\w+,"bin"\)/, 'the engine bin folder is no longer <cache>/bin');
    assert.match(text, /\.join\(\w+\.bin,"rg"\);if\(yield\*\w+\.isFile\(\w+\)/, 'the engine no longer runs <cache>/opencode/bin/rg before downloading one');
  },

  'engine-skill-folders': (t) => {
    const { opencodeCli } = JSON.parse(source('packages/electron/package.json'));
    assert.equal(opencodeCli?.version, '2.0.22', 'the bundled engine moved: run the probe with --only skills-mcp again, then update this pin');
    const binary = path.join(repoRoot, 'packages/electron/resources/opencode-cli/opencode');
    if (!fs.existsSync(binary)) {
      t.diagnostic('the engine binary is not prepared here, so only the pin is checked');
      return;
    }
    const text = fs.readFileSync(binary, 'latin1');
    assert.match(text, /path:\w+\.make\(\w+\.join\(\w+,"skills"\)\)/, 'the engine no longer reads skills from <config dir>/skills');
    assert.ok(text.includes('scan("{*.md,**/SKILL.md}",{cwd:'), 'the engine no longer finds a skill as <folder>/SKILL.md');
    assert.match(text, /:\w+\.basename\(\w+\.dirname\(\w+\)\),/, 'the engine no longer takes a skill id from its folder name');
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

  'quota-provider-exclusive': async () => {
    const { registerQuotaProvider, builtInQuotaProvidersShown } = await importUpstream('packages/web/server/lib/quota/providers/registered.js');
    assert.equal(builtInQuotaProvidersShown(), true, 'the built-in quota providers are hidden with no exclusive provider registered');
    const probe = { providerId: 'contract-alone', providerName: 'Alone', isConfigured: () => true, fetchQuota: async () => ({ providerId: 'contract-alone', ok: true }) };
    const unregister = registerQuotaProvider(probe, { exclusive: true });
    try {
      assert.equal(builtInQuotaProvidersShown(), false, 'an exclusive provider no longer hides the built-in quota providers');
    } finally {
      unregister();
    }
    assert.equal(builtInQuotaProvidersShown(), true, 'removing the exclusive provider no longer brings the built-in quota providers back');
    const registry = source('packages/web/server/lib/quota/providers/index.js');
    has(registry, /const builtInProviders = \(\) => \(builtInQuotaProvidersShown\(\) \? Object\.entries\(registry\) : \[\]\);/, 'the provider list no longer leaves the built-in providers out while an exclusive one is registered');
    has(registry, /for \(const \[id, provider\] of \[\.\.\.builtInProviders\(\), \.\.\.registeredQuotaProviders\(\)\]\)/, 'the provider list no longer reads the built-in providers through the exclusive check');
    has(registry, /Object\.hasOwn\(registry, providerId\)\s*\? \(builtInQuotaProvidersShown\(\) \? registry\[providerId\] : undefined\)/, 'the dispatcher no longer refuses a built-in provider while an exclusive one is registered');
    assert.equal(lineCount(registry, 'registry[providerId]'), 1, 'the dispatcher reaches a built-in provider some other way');
    has(source('packages/mittr-server/src/mittr/index.js'), /\}\), \{ exclusive: true \}\);/, 'Mittr no longer registers as the only usage provider');
  },

  'quota-ui-registry': () => {
    const registry = source('packages/ui/src/lib/quota/providers/index.ts');
    has(registry, /^export function registerQuotaProvider\(meta: \{ id: string; name: string \}, options\?: \{ first\?: boolean; exclusive\?: boolean \}\): void \{/m, 'registerQuotaProvider is no longer exported with this signature');
    has(registry, /if \(options\?\.exclusive\) \{\s*const kept = QUOTA_PROVIDERS\.filter\(\(provider\) => runTimeProviders\.has\(provider\.id\)\);\s*QUOTA_PROVIDERS\.splice\(0, QUOTA_PROVIDERS\.length, \.\.\.kept\);/, 'an exclusive usage provider no longer takes the built-in providers off the list');
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
    const accountClass = source('packages/mittr-ui/src/accounts/footerButtonClass.ts').match(/^export const FOOTER_BUTTON_CLASS = '([^']+)';$/m)?.[1];
    assert.equal(accountClass, footerClass, 'the account button no longer wears the sidebar footer button classes');
  },

  'ui-auth-provider-registry': (t) => {
    const server = source('packages/web/server/index.js');
    has(server, /^import \{ createUiAuth, registerUiAuthProvider \} from '\.\/lib\/ui-auth\/ui-auth\.js';$/m);
    has(pluginContext(server), /uiAuth: \{\s*registerProvider: registerUiAuthProvider,\s*passwordEnabled: \(\) => typeof uiPassword === 'string' && uiPassword\.trim\(\)\.length > 0,\s*createClient: \(options\) => remoteClientAuthRuntime\.createClient\(options\),\s*\},/, 'the plugin context no longer hands plugins the UI auth provider registry');
    const clients = source('packages/web/server/lib/client-auth/remote-clients.js');
    has(clients, /const createClient = async \(\{\s*label,\s*fallbackLabel,\s*expiresAt,\s*clientKind,\s*dedupeKey,\s*authMethod,/, 'createClient no longer takes fallbackLabel, expiresAt and authMethod');
    has(clients, /return \{ client: publicClient\(client\), token \};/, 'createClient no longer answers { client, token }');
    has(clients, /^const MAX_LABEL_LENGTH = 80;$/m, 'the remote clients store no longer cuts a label at 80 UTF-16 units, which clientLabelFor fits');
    has(clients, /return trimmed\.length > MAX_LABEL_LENGTH \? trimmed\.slice\(0, MAX_LABEL_LENGTH\) : trimmed;/, 'the remote clients store no longer trims and cuts a label by UTF-16 length');
    has(server, /const remoteClientAuthRuntime = createRemoteClientAuthRuntime\(\{/, 'the server no longer builds the remote clients store the plugin context mints from');
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
    has(source('packages/web/bin/cli-entry.js'), /return parsedEntryName === expectedBinName\.trim\(\)\.toLowerCase\(\);/, 'cli.js no longer takes an entry file named openchamber as being run directly');
    const startup = source('packages/web/bin/lib/cli-startup.js');
    has(startup, /const entry = typeof process\.argv\[1\] === 'string' && process\.argv\[1\]\.trim\(\)\.length > 0\s*\? process\.argv\[1\]/, 'the startup entry no longer comes from argv[1]');
    has(startup, /const args = \[resolveCliEntrypoint\(\), 'serve', '--foreground', '--port'/, 'the startup arguments no longer begin with the entry');
    assert.equal(lineCount(startup, 'buildStartupArgs(options)'), 3, 'the systemd unit, the macOS wrapper and the Windows wrapper no longer all take their command from buildStartupArgs');
    const wrapper = source('packages/mittr-server/bin/mittrcraft.mjs');
    has(wrapper, /const SERVER_CLI = path\.resolve\(here, '\.\.', '\.\.', 'web', 'bin', 'cli\.js'\);/, 'the mittrcraft bin no longer points at the server CLI');
    has(wrapper, /^process\.argv\[1\] = ENTRY;$/m, 'the mittrcraft bin no longer sets argv[1] to the entry that startup units run');
    assert.equal(source('packages/mittr-server/bin/openchamber.mjs'), "import './mittrcraft.mjs';\n");
    has(source('packages/web/bin/lib/cli-args.js'), /uiPassword: process\.env\.OPENCHAMBER_UI_PASSWORD \|\| undefined,/, 'the CLI no longer reads OPENCHAMBER_UI_PASSWORD, the name the bin maps MITTRCRAFT_UI_PASSWORD onto');
    has(source('packages/web/server/lib/security/bind-host.js'), /env\?\.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN === 'true'/, 'the server no longer reads OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN');
    has(source('packages/web/server/index.js'), /process\.env\.OPENCHAMBER_DATA_DIR/, 'the server no longer reads OPENCHAMBER_DATA_DIR');
    has(source('packages/web/server/lib/server-plugins.js'), /const SERVER_PLUGINS_ENV = 'OPENCHAMBER_SERVER_PLUGINS';/);
    assert.ok(fs.existsSync(path.join(repoRoot, 'packages/mittr-server/bin', '..', '..', 'web', 'bin', 'cli.js')));
    has(wrapper, /const PRODUCT = path\.resolve\(here, 'product-env\.json'\);/, 'the mittrcraft bin no longer reads the product env beside it');
    has(wrapper, /productEnv: readProductEnv\(PRODUCT\),/, 'the mittrcraft bin no longer fills in the product env');
    has(source('packages/web/bin/cli.js'), /process\.env\.BUN_BINARY/, 'the server CLI no longer reads BUN_BINARY');
  },

  'session-auth-methods-slot': () => {
    const gate = source('packages/ui/src/components/auth/SessionAuthGate.tsx');
    has(gate, /^import \{ ProductSlot, translateProductSessionAuthDescription, type SessionAuthRuntime \} from '@\/lib\/product-plugins';$/m, 'SessionAuthGate no longer imports ProductSlot');
    assert.equal(lineCount(gate, '<ProductSlot'), 1, 'SessionAuthGate renders ProductSlot more than once, or not at all');
    has(gate, /<\/form>\s*\)\}\s*<ProductSlot\s+name="session-auth-methods"\s+isTunnelLocked=\{isTunnelLocked\}\s+runtime=\{sessionAuthRuntime\(\)\}\s+onSignedIn=\{finishProviderSignIn\}\s+\/>\s*\{showHostSwitcher && \(/, 'the session-auth-methods slot is no longer after the password form, outside the tunnel check, before the host switcher');
    has(gate, /\{!isTunnelLocked && passwordEnabled && \(\s*<form onSubmit=\{handleSubmit\}/, 'the password form no longer waits for passwordEnabled');
    has(gate, /setPasswordEnabled\(data\.passwordEnabled !== false\);/, 'the gate no longer reads passwordEnabled from the 401 session status');
    const finish = gate.slice(gate.indexOf('const finishProviderSignIn = '), gate.indexOf('const handleSubmit = '));
    for (const line of ['shouldIssueDesktopClientToken()', 'clientToken = await issueDesktopClientToken();', 'applyDesktopClientToken(clientToken, runtime, getRuntimeExtraHeadersSync())', "setState('authenticated');"]) assert.ok(finish.includes(line), `finishProviderSignIn no longer does ${line}`);
    has(finish, /const runtime: RuntimeIdentity = \{ apiBaseUrl: signInApiBaseUrl, runtimeKey: signInHostKey \};/, 'the sign-in finisher is no longer bound to the host the gate was drawn for');
    assert.ok(lineCount(finish, 'isRuntimeIdentityActive(runtime)') >= 3, 'the sign-in finisher no longer checks the host is still the one it was bound to');
    const issue = gate.slice(gate.indexOf('const issueDesktopClientToken = '), gate.indexOf('const shouldUseDesktopShellPasswordLogin'));
    has(issue, /runtimeFetch\('\/api\/client-auth\/clients', \{\s*method: 'POST',/, 'issueDesktopClientToken no longer posts /api/client-auth/clients');
    const plugins = source('packages/ui/src/lib/product-plugins.ts');
    has(plugins, /'session-auth-methods': SessionAuthMethodsProps;/);
    has(plugins, /export type SessionAuthRuntime = 'web' \| 'desktop-local' \| 'desktop-remote';/);
    has(plugins, /onSignedIn: \(clientToken\?: string\) => Promise<boolean>;/);
    const key = gate.match(/^const TRUST_DEVICE_STORAGE_KEY = '([^']+)';$/m)?.[1];
    assert.ok(key, 'the gate no longer names its trust-device storage key in TRUST_DEVICE_STORAGE_KEY');
    has(source('packages/mittr-ui/src/ui-auth/adApi.ts'), new RegExp(`^export const TRUST_DEVICE_STORAGE_KEY = '${key.replace(/\./g, '\\.')}';$`, 'm'), 'the company sign-in no longer reads the gate\'s trust-device choice');
  },

  'session-auth-description': () => {
    const gate = source('packages/ui/src/components/auth/SessionAuthGate.tsx');
    has(gate, /: \(translateProductSessionAuthDescription\(\{ passwordEnabled, runtime: sessionAuthRuntime\(\) \}\) \?\? t\('sessionAuth\.locked\.passwordDescription'\)\)\}/, 'the gate no longer asks the product for its description before upstream\'s');
    has(gate, /\? t\('sessionAuth\.locked\.tunnelDescription'\)/, 'the tunnel description is no longer the gate\'s own');
    const plugins = source('packages/ui/src/lib/product-plugins.ts');
    has(plugins, /sessionAuthDescription\?: \(context: ProductSessionAuthContext\) => string \| null;/);
    has(plugins, /type ProductSessionAuthContext = \{ passwordEnabled: boolean; runtime: SessionAuthRuntime \};/);
  },

  'desktop-runtime-detect': () => {
    const desktop = source('packages/ui/src/lib/desktop.ts');
    has(desktop, /^export const isDesktopShell = \(\): boolean => \{\s*if \(typeof window === 'undefined'\) return false;\s*return isElectronShell\(\);\s*\};$/m, 'isDesktopShell no longer answers whether the window is the Electron shell');
    has(source('packages/mittr-ui/src/ui-auth/SidebarProfile.tsx'), /^import \{ isDesktopShell \} from '\.\.\/\.\.\/\.\.\/ui\/src\/lib\/desktop';$/m, 'SidebarProfile no longer asks isDesktopShell');
    const gate = source('packages/ui/src/components/auth/SessionAuthGate.tsx');
    has(gate, /const sessionAuthRuntime = \(\): SessionAuthRuntime => \{\s*if \(!isDesktopShell\(\)\) return 'web';\s*return isLocalDesktopRuntime\(\) \? 'desktop-local' : 'desktop-remote';\s*\};/, 'the gate no longer tells web, local desktop and remote desktop apart');
    has(gate, /const shouldUseDesktopShellPasswordLogin = \(\): boolean => \{\s*return isDesktopShell\(\) && !isLocalDesktopRuntime\(\);\s*\};/, 'the desktop shell no longer signs in to a remote host with a password through the shell');
  },

  'ad-sign-in-ui': () => {
    const checkbox = source('packages/ui/src/components/ui/checkbox.tsx');
    has(checkbox, /^export const Checkbox = React\.memo/m, 'Checkbox is no longer exported');
    for (const prop of ['checked: boolean;', 'onChange: (checked: boolean) => void;', 'disabled?: boolean;', 'ariaLabel?: string;']) assert.ok(checkbox.includes(prop), `Checkbox no longer takes ${prop}`);
    has(source('packages/ui/src/components/ui/input.tsx'), /^export \{ Input \}$/m, 'Input is no longer exported');
    const button = source('packages/ui/src/components/ui/button.tsx');
    has(button, /^export \{ Button \}$/m, 'Button is no longer exported');
    has(button, /^ {8}outline:$/m, 'Button no longer has an outline variant');
    has(button, /^ {8}icon: "size-9",$/m, 'Button no longer has an icon size');
    const sprite = source('packages/ui/src/components/icon/sprite.ts');
    for (const name of ['user', 'lock', 'key', 'loader-4']) has(sprite, new RegExp(`^ {2}"${name}": `, 'm'), `the ${name} icon is gone`);
    const url = source('packages/ui/src/lib/runtime-url.ts');
    has(url, /^export const getRuntimeUrlResolver = \(\): RuntimeUrlResolver => activeRuntimeUrlResolver;$/m, 'getRuntimeUrlResolver is no longer exported');
    has(url, /^ {4}auth: http,$/m, 'the URL resolver no longer builds auth URLs the way it builds API URLs');
    has(source('packages/ui/src/lib/runtime-fetch.ts'), /input\.startsWith\('\/auth\/'\)/, 'runtimeFetch no longer sends /auth/ paths to the runtime\'s server');
  },

  'server-only-secrets': () => {
    const { childSecrets } = item('server-only-secrets');
    const secretName = /\b(?:(?:OPENCHAMBER|OPENCODE)_[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|P8|KEY|KEY_ID|TEAM_ID)|NGROK_AUTHTOKEN)\b/g;
    const read = new Set();
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
        const relative = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(relative);
        } else if (/\.(?:js|mjs)$/.test(entry.name) && !/\.test\.(?:js|mjs)$/.test(entry.name)) {
          for (const [name] of source(relative).matchAll(secretName)) read.add(name);
        }
      }
    };
    walk('packages/web/server');
    walk('packages/web/bin');
    const known = new Set([...SERVER_ONLY_SECRETS, ...childSecrets]);
    assert.deepEqual([...read].filter((name) => !known.has(name)).sort(), [], 'upstream reads a secret the engine would inherit; withhold it in SERVER_ONLY_SECRETS or record it as a child secret');
    const ours = new Set(['MITTRCRAFT_UI_PASSWORD', 'JIRA_TOKEN', 'PLANE_API_KEY']);
    assert.deepEqual([...known].filter((name) => !ours.has(name) && !read.has(name)).sort(), [], 'upstream no longer reads a secret recorded here; it was renamed or dropped');
  },

  'login-shell-env-before-plugins': () => {
    const server = source('packages/web/server/index.js');
    const applied = server.search(/^applyLoginShellEnvSnapshot\(\);$/m);
    const plugins = server.indexOf('serverPlugins = await loadServerPlugins({');
    assert.ok(applied > 0, 'index.js no longer applies the login-shell snapshot when it is imported');
    assert.ok(plugins > applied, 'plugins are no longer set up after the login-shell snapshot is applied');
    const runtime = source('packages/web/server/lib/opencode/env-runtime.js');
    const apply = runtime.slice(runtime.indexOf('const applyLoginShellEnvSnapshot = () => {'));
    has(apply, /for \(const \[key, value\] of Object\.entries\(snapshot\)\) \{\s*if \(skipKeys\.has\(key\)\) \{\s*continue;\s*\}\s*const existing = process\.env\[key\];\s*if \(typeof existing === 'string' && existing\.length > 0\) \{\s*continue;\s*\}\s*process\.env\[key\] = value;/, 'the login-shell snapshot no longer fills every variable process.env lacks');
    has(apply, /const skipKeys = new Set\(\['PWD', 'OLDPWD', 'SHLVL', '_', 'ARGV0'\]\);/, 'the login-shell snapshot skips other variables now');
  },

  'plugin-engine-env-withholds': async (t) => {
    const { loadServerPlugins } = await importUpstream('packages/web/server/lib/server-plugins.js');
    const plugin = path.join(tempDir(t, 'contract-withhold-'), 'withhold.mjs');
    fs.writeFileSync(plugin, 'export default () => ({ engineEnv: () => ({ WITHHELD_SECRET: undefined }) });');
    const plugins = await loadServerPlugins({ specifiers: [plugin], context: { app: {}, dataDir: '/data', logger: console } });
    const engineEnv = await plugins.engineEnv();
    assert.ok(Object.hasOwn(engineEnv, 'WITHHELD_SECRET'), 'a plugin engine variable set to undefined is dropped before the merge');
    const child = spawnSync(process.execPath, ['-e', 'console.log(process.env.WITHHELD_SECRET === undefined)'], {
      encoding: 'utf8',
      env: { ...process.env, WITHHELD_SECRET: 'from the shell', ...engineEnv },
    });
    assert.equal(child.stdout.trim(), 'true', 'an undefined variable reaches the child environment');

    const lifecycle = source('packages/web/server/lib/opencode/lifecycle.js');
    has(lifecycle, /const processEnv = stripAppImageLauncherEnv\(stripAppImageArgv0Leak\(applyProviderEnvAliases\(\{\s*\.\.\.shellEnv,\s*\.\.\.process\.env,\s*\.\.\.managedOpenCodeEnv,/, 'the engine start no longer spreads the managed env after the shell snapshot and process.env');
    has(lifecycle, /checkOpenCodeBinary\(resolveManagedOpenCodeLaunchSpec\(resolvedBinary\), \{\s*env: \{ \.\.\.process\.env, \.\.\.managedOpenCodeEnv \},/, 'the version preflight no longer spreads the managed env after process.env');
    const server = source('packages/web/server/index.js');
    assert.equal(
      lineCount(server, 'env: { ...getLoginShellEnvSnapshot(), ...process.env, ...(await getServerPluginEngineEnv()), PATH: buildManagedOpenCodePath() }'),
      2,
      'the v2 install and the CLI upgrade no longer spread the plugin engine env after the shell snapshot and process.env',
    );
    has(server, /readOpenCodeCliVersion\(resolveManagedOpenCodeLaunchSpec\(binary\), \{\s*env: \{ \.\.\.process\.env, \.\.\.\(await getServerPluginEngineEnv\(\)\) \},/, 'the compatibility probe no longer spreads the plugin engine env after process.env');
    has(server, /getManagedOpenCodeEnv: async \(\) => \(\{\s*\.\.\.\(managedConfigRuntime \? await managedConfigRuntime\.buildManagedChildEnv\(\) : \{\}\),\s*\.\.\.\(await getServerPluginEngineEnv\(\)\),\s*\}\)/, 'the plugin engine env is no longer the last layer of the managed env');
  },

  'update-install-disabled-env': () => {
    const routes = source('packages/web/server/lib/opencode/openchamber-routes.js');
    const route = routes.slice(routes.indexOf("app.post('/api/openchamber/update-install'"));
    const guard = route.indexOf("if (isUpdateCheckDisabled(process.env)) return res.status(400).json({ error: 'No update available', updatesDisabled: true });");
    assert.ok(guard > 0, 'the update-install route no longer answers the switch');
    for (const step of ["await import('child_process')", 'await checkForUpdates()', 'spawnChild(']) {
      const at = route.indexOf(step);
      assert.ok(at > guard, `${step} no longer comes after the switch`);
    }
    has(routes, /const isUpdateCheckDisabled = \(env\) => \{\s*const value = typeof env\?\.OPENCHAMBER_UPDATE_CHECK_DISABLED === 'string' \? env\.OPENCHAMBER_UPDATE_CHECK_DISABLED\.trim\(\)\.toLowerCase\(\) : '';\s*return value === '1' \|\| value === 'true';/, 'the switch no longer reads 1 or true');
  },

  'api-only-switch': () => {
    const server = source('packages/web/server/index.js');
    has(server, /const apiOnly = options\.apiOnly === true \|\| isEnvFlagEnabled\(process\.env\.OPENCHAMBER_API_ONLY\);/, 'API-only mode is no longer the option or OPENCHAMBER_API_ONLY');
    has(server, /const isEnvFlagEnabled = \(value\) => \{\s*if \(value === true \|\| value === 1\) return true;\s*if \(typeof value !== 'string'\) return false;\s*const normalized = value\.trim\(\)\.toLowerCase\(\);\s*return normalized === '1' \|\| normalized === 'true';/, 'OPENCHAMBER_API_ONLY no longer reads 1 or true, trimmed and in any case');
    has(source('packages/web/server/lib/opencode/startup-pipeline-runtime.js'), /if \(apiOnly\) \{\s*staticRoutesRuntime\.registerApiOnlyFallbackRoutes\(app\);\s*\} else \{\s*staticRoutesRuntime\.registerStaticRoutes\(app\);\s*\}/, 'API-only mode no longer replaces the web build with the API-only fallback');
    const serverOptions = source('packages/web/server/lib/opencode/cli-options.js');
    has(serverOptions, /if \(optionName === 'api-only'\) \{\s*options\.apiOnly = true;/, 'the server no longer reads --api-only');
    has(serverOptions, /const optionName = eqIndex >= 0 \? arg\.slice\(2, eqIndex\) : arg\.slice\(2\);/, 'the server no longer reads --api-only=<anything> as --api-only');
    has(source('packages/web/bin/lib/cli-args.js'), /case 'api-only':\s*options\.apiOnly = true;/, 'the CLI no longer reads --api-only');
    const serve = source('packages/web/bin/lib/commands-serve.js');
    has(serve, /startWebUiServer\(\{[^}]*apiOnly: options\.apiOnly === true,/, 'the foreground server no longer gets API-only mode from the CLI option');
    has(serve, /if \(options\.apiOnly === true\) \{\s*serverArgs\.push\('--api-only'\);/, 'the daemon no longer gets --api-only');
  },

  'serve-runtime-switch': () => {
    const cli = source('packages/web/bin/cli.js');
    has(cli, /function getBunBinary\(\) \{\s*if \(typeof process\.env\.BUN_BINARY === 'string' && process\.env\.BUN_BINARY\.trim\(\)\.length > 0\) \{\s*return process\.env\.BUN_BINARY\.trim\(\);/, 'BUN_BINARY no longer names the runtime first');
    has(cli, /spawnSync\(BUN_BIN, \['--version'\]/, 'the runtime is no longer probed with --version');
    has(cli, /return isBunInstalled\(\) \? 'bun' : 'node';/, 'the server runtime is no longer the probed one');
    const serve = source('packages/web/bin/lib/commands-serve.js');
    has(serve, /const runtimeBin = preferredRuntime === 'bun' \? bunBin : process\.execPath;/, 'the daemon no longer runs on the probed runtime');
    has(serve, /const child = spawn\(runtimeBin, serverArgs, \{[\s\S]{0,200}env: \{\s*\.\.\.process\.env,/, 'the daemon no longer gets an explicit copy of the CLI environment');
  },

  'web-shell-after-plugins': () => {
    const routes = source('packages/web/server/lib/opencode/static-routes-runtime.js');
    has(routes, /const env = typeof process\.env\.OPENCHAMBER_DIST_DIR === 'string' \? process\.env\.OPENCHAMBER_DIST_DIR\.trim\(\) : '';\s*if \(env\) \{\s*return path\.resolve\(env\);\s*\}\s*return path\.join\(__dirname, '\.\.', 'dist'\);/, 'the web build is no longer found through OPENCHAMBER_DIST_DIR or beside the server');
    has(routes, /app\.use\(express\.static\(distPath, \{/, 'the web build is no longer served by express.static');
    has(routes, /res\.sendFile\(path\.join\(distPath, 'index\.html'\)\);/, 'other app paths no longer get res.sendFile of index.html');
    const manifest = source('packages/web/server/lib/opencode/pwa-manifest-routes.js');
    has(manifest, /app\.get\('\/manifest\.webmanifest', async \(req, res\) => \{/, 'the PWA manifest route moved');
    has(manifest, /res\.send\(JSON\.stringify\(manifest\)\);/, 'the PWA manifest is no longer sent with res.send');
    has(manifest, /description: 'Web interface companion for OpenCode AI coding agent',/, 'the PWA manifest description changed');
    has(manifest, /const DEFAULT_PWA_APP_NAME = 'OpenChamber';/, 'the PWA manifest default name changed');
    has(source('packages/web/server/lib/opencode/startup-pipeline-runtime.js'), /staticRoutesRuntime\.registerStaticRoutes\(app\);/, 'the startup pipeline no longer mounts the web build');
    const server = source('packages/web/server/index.js');
    const plugins = server.indexOf('serverPlugins = await loadServerPlugins({');
    const pipeline = server.indexOf('const startupPipelineResult = await startupPipelineRuntime.run({');
    assert.ok(plugins > 0 && pipeline > plugins, 'server plugins no longer set up before the startup pipeline mounts the web build');
  },

  noindex: () => {
    const server = source('packages/web/server/index.js');
    has(server, /app\.use\(\(req, res, next\) => \{\s*res\.setHeader\('X-Robots-Tag', 'noindex, nofollow'\);/, 'no middleware sets X-Robots-Tag to noindex, nofollow');
    has(server, /app\.get\('\/robots\.txt', \(_req, res\) => \{\s*res\.type\('text\/plain'\)\.send\('User-agent: \*\\nDisallow: \/\\n'\);/, 'the robots.txt route no longer answers User-agent: * and Disallow: /');
    const header = server.search(/res\.setHeader\('X-Robots-Tag', 'noindex, nofollow'\)/);
    const robots = server.search(/app\.get\('\/robots\.txt'/);
    const cors = server.indexOf("const origin = typeof req.headers.origin === 'string'");
    assert.ok(cors > 0, 'the CORS middleware is no longer in index.js');
    assert.ok(header >= 0 && header < cors, 'X-Robots-Tag is no longer set before the CORS middleware');
    assert.ok(robots >= 0 && robots < cors, 'robots.txt is no longer answered before the CORS middleware');
  },

  'projects-store': () => {
    const store = source('packages/ui/src/stores/useProjectsStore.ts');
    has(store, /^export const useProjectsStore = create<ProjectsStore>\(\)\(/m, 'useProjectsStore is no longer a store created from ProjectsStore');
    has(store, /^interface ProjectsStore \{[^}]*^ {2}projects: ProjectEntry\[\];$/ms, 'the projects store no longer exposes projects as ProjectEntry[]');
    has(source('packages/ui/src/lib/api/types.ts'), /^export interface ProjectEntry \{\n {2}id: string;\n {2}path: string;\n {2}label\?: string;$/m, 'a project entry no longer has id, path and an optional label');
  },

  'open-external-url': () => {
    has(source('packages/ui/src/lib/url.ts'), /^export const openExternalUrl = \(url: string\): Promise<boolean> =>\n {2}isExternalHttpUrl\(url\) \? openValidatedExternalUrl\(url\) : Promise\.resolve\(false\);$/m, 'openExternalUrl(url) no longer answers a Promise<boolean> and opens only web addresses');
  },

  'my-work-panel-ui': () => {
    const dialog = source('packages/ui/src/components/ui/dialog.tsx');
    for (const name of ['Dialog', 'DialogContent', 'DialogDescription', 'DialogHeader', 'DialogTitle']) {
      has(dialog, new RegExp(`^export \\{[^}]*\\n {2}${name},$[^}]*\\}`, 'm'), `dialog no longer exports ${name}`);
    }
    has(source('packages/ui/src/components/ui/collapsible.tsx'), /^const Collapsible = BaseCollapsible\.Root;$/m, 'Collapsible is no longer the Base UI root, which takes defaultOpen and onOpenChange');
    has(source('packages/ui/src/components/ui/collapsible.tsx'), /^export \{ Collapsible, CollapsibleTrigger, CollapsibleContent \};$/m);
    has(source('packages/ui/src/components/ui/input.tsx'), /^export \{ Input \}$/m);
    const button = source('packages/ui/src/components/ui/button.tsx');
    has(button, /^\s+chip: cn\($/m, 'Button lost the chip variant');
    has(button, /aria-pressed:bg-interactive-selection/, 'a pressed chip no longer wears the selection colour');
    has(button, /^\s+outline:$/m, 'Button lost the outline variant');
    has(button, /^\s+sm: "/m, 'Button lost the sm size');
    const sprite = source('packages/ui/src/components/icon/sprite.ts');
    for (const name of ['briefcase', 'search', 'refresh', 'loader-4', 'error-warning', 'arrow-right-s', 'task', 'stack', 'play', 'folder']) {
      has(sprite, new RegExp(`^ {2}"${name}": `, 'm'), `the ${name} icon is gone`);
    }
    has(source('packages/ui/src/lib/utils.ts'), /^export function formatDirectoryName\(path: string \| null \| undefined, homeDirectory\?: string \| null\): string \{$/m, 'formatDirectoryName(path) changed');
  },

  'session-create-selection': () => {
    const actions = source('packages/ui/src/sync/session-actions.ts');
    has(actions, /^export type SessionCreateSelection = \{ model\?: ModelRef; agent\?: string \}$/m, 'SessionCreateSelection is no longer { model?: ModelRef; agent?: string }');
    has(actions, /^export async function createSession\(\n {2}title\?: string,\n {2}directoryOverride\?: string \| null,\n {2}metadata\?: Metadata,\n {2}selectionTransition\?: "submitted-draft",\n {2}selection\?: SessionCreateSelection,\n {2}navigation: "open" \| "preserve" = "open",\n\): Promise<Session \| null> \{$/m, 'createSession no longer takes (title, directory, metadata, selectionTransition, selection, navigation)');
    has(actions, /opencodeClient\.createSession\(\s*\{ title, metadata, model: selection\?\.model, agent: selection\?\.agent \},\s*effectiveDirectory,\s*\)/, 'createSession no longer creates the session on the selection');
    has(actions, /if \(navigation === "open"\) useSessionUIStore\.getState\(\)\.setCurrentSession\(session\.id, sessionDirectory, selectionTransition\)/, "createSession no longer opens the session for 'open'");
    has(actions, /console\.error\("\[session-actions\] createSession failed", error\)\s*return null\s*\}\s*\}/, 'a failed createSession no longer answers null');
    has(source('node_modules/@opencode/client/dist/promise/generated/types.d.ts'), /export type ModelRef = \{\s*id: string;\s*providerID: string;\s*variant\?: string;\s*\};/, 'ModelRef is no longer { id, providerID, variant? }');
    has(source('packages/ui/src/sync/session-ui-store.ts'), /^ {2}initializeNewOpenChamberSession: \(sessionId: string, agents: unknown\[\]\) => void$/m, 'initializeNewOpenChamberSession(sessionId, agents) changed');
    has(source('packages/ui/src/stores/useUIStore.ts'), /^ {2}closeMainSurfaces: \(\) => void;$/m, 'closeMainSurfaces() is gone');
  },

  'work-tracking-settings-ui': () => {
    const section = source('packages/ui/src/components/sections/shared/SettingsSection.tsx');
    has(section, /^export const SettingsSection: React\.FC<SettingsSectionProps> = \(\{/m, 'SettingsSection is gone');
    has(section, /interface SettingsSectionProps \{[^}]*\n {2}title\?: React\.ReactNode;[^}]*\n {2}info\?: React\.ReactNode;[^}]*\n {2}contentClassName\?: string;/s, 'SettingsSection no longer takes title, info and contentClassName');
    has(section, /^export const SettingsStackedField: React\.FC<SettingsStackedFieldProps> = \(\{/m, 'SettingsStackedField is gone');
    has(section, /interface SettingsStackedFieldProps \{\s*label: React\.ReactNode;[^}]*\n {2}className\?: string;/s, 'SettingsStackedField no longer takes label and className');
    has(section, /^export const SettingsControlGroup: React\.FC<SettingsControlGroupProps> = \(\{/m, 'SettingsControlGroup is gone');
    has(section, /interface SettingsControlGroupProps \{\s*title\?: React\.ReactNode;\s*description\?: React\.ReactNode;[^}]*\n {2}contentClassName\?: string;/s, 'SettingsControlGroup no longer takes title, description and contentClassName');
    has(section, /^export const SETTINGS_HELPER_CLASS = /m, 'SETTINGS_HELPER_CLASS is gone');
    const input = source('packages/ui/src/components/ui/input.tsx');
    has(input, /^function Input\(\{ className, type, \.\.\.props \}: React\.ComponentProps<"input">\) \{$/m, 'Input no longer takes the input element props');
    has(input, /^\s+type=\{type\}$/m, 'Input no longer passes its type through');
    has(input, /^\s+\{\.\.\.props\}\n\s+\/>$/m, 'Input no longer passes the rest of its props through last');
    has(input, /^export \{ Input \}$/m);
    const button = source('packages/ui/src/components/ui/button.tsx');
    for (const variant of ['default', 'outline', 'ghost']) has(button, new RegExp(`^\\s+${variant}:`, 'm'), `Button lost the ${variant} variant`);
    has(button, /^\s+sm: "/m, 'Button lost the sm size');
    has(source('packages/ui/src/components/ui/index.ts'), /^export \{ toast \} from '\.\/toast'/m, 'toast is no longer exported from components/ui');
    const sprite = source('packages/ui/src/components/icon/sprite.ts');
    for (const name of ['loader-4', 'stack', 'close', 'add', 'checkbox-circle', 'error-warning']) {
      has(sprite, new RegExp(`^ {2}"${name}": `, 'm'), `the ${name} icon is gone`);
    }
    has(source('packages/ui/src/lib/i18n/index.ts'), /^export \{ useI18n \} from '\.\/useI18n';$/m, 'useI18n is no longer exported from lib/i18n');
    has(source('packages/ui/src/lib/i18n/messages/en.ts'), /^ {2}'common\.loading': /m, 'common.loading is gone');
    has(source('packages/ui/src/lib/i18n/messages/en.settings.ts'), /^ {2}'settings\.common\.actions\.saveChanges': /m, 'settings.common.actions.saveChanges is gone');
  },

  'guest-send-selection': () => {
    const upstream = source('packages/ui/src/lib/guests/start-session.ts');
    const ours = source('packages/mittr-ui/src/work/sendSelection.ts');
    const arrowBody = (text, declaration) => {
      const start = text.indexOf(declaration);
      assert.ok(start >= 0, `${declaration} is gone`);
      const open = text.indexOf('=> {', start) + 3;
      let depth = 0;
      for (let index = open; index < text.length; index += 1) {
        if (text[index] === '{') depth += 1;
        else if (text[index] === '}' && --depth === 0) {
          return text.slice(start + declaration.length, index + 1).replace(/\s+/g, ' ').trim();
        }
      }
      assert.fail(`${declaration} has no end`);
    };
    for (const [theirs, mine] of [
      ['const resolveDefaultAgentName = ', 'const resolveDefaultAgentName = '],
      ['const resolveDefaultModelSelection = ', 'const resolveDefaultModelSelection = '],
      ['const resolveDefaultVariant = ', 'const resolveDefaultVariant = '],
      ['const captureGuestSendSelection = ', 'export const captureSendSelection = '],
    ]) {
      assert.equal(arrowBody(ours, mine), arrowBody(upstream, theirs), `${theirs.trim()} changed upstream; bring sendSelection.ts in line`);
    }
    for (const [name, from] of [
      ['parseModelIdentifier', 'lib/modelIdentifier'],
      ['modelVariantNames', 'lib/modelVariants'],
      ['useConfigStore', 'stores/useConfigStore'],
      ['useSelectionStore', 'sync/selection-store'],
    ]) {
      assert.ok(upstream.includes(`import { ${name} } from '@/${from}';`), `start-session.ts no longer takes ${name} from @/${from}`);
      assert.ok(ours.includes(`import { ${name} } from '../../../ui/src/${from}';`), `sendSelection.ts no longer takes ${name} from ${from}`);
    }
    has(upstream, /const sendSelection = captureGuestSendSelection\(\);/, 'startGuestSession no longer starts on captureGuestSendSelection()');
  },

  'agent-tool-settings-keys': () => {
    const registry = JSON.parse(source('packages/web/server/lib/opencode/settings-registry.json'));
    for (const key of ['agentControlToolEnabled', 'agentWebToolEnabled', 'agentToolsCodeMode']) {
      assert.ok(Object.hasOwn(registry.fields, key), `the settings registry no longer has ${key}`);
      has(source('packages/web/server/lib/opencode/settings-helpers.js'), new RegExp(`if \\(typeof candidate\\.${key} === 'boolean'\\) \\{\\s*result\\.${key} = candidate\\.${key};`), `${key} is no longer kept as a boolean`);
    }
    const runtime = source('packages/web/server/lib/opencode/settings-runtime.js');
    const managedKeys = runtime.slice(runtime.indexOf('const MANAGED_PLUGIN_SETTINGS_KEYS = new Set(['), runtime.indexOf(']);', runtime.indexOf('const MANAGED_PLUGIN_SETTINGS_KEYS')));
    for (const key of ['agentControlToolEnabled', 'agentToolsCodeMode']) assert.ok(managedKeys.includes(`'${key}'`), `a change of ${key} no longer rewrites the managed config`);
    const managed = source('packages/web/server/lib/opencode/managed-config-file.js');
    has(managed, /const includeControl = settings\?\.agentControlToolEnabled !== false;/, 'the control tool is no longer on unless set false');
    has(managed, /const codeMode = settings\?\.agentToolsCodeMode === true;/, 'Code Mode is no longer off unless set true');
  },

  'managed-config-plugin-order': async (t) => {
    const managed = source('packages/web/server/lib/opencode/managed-config-file.js');
    has(managed, /plugins: \[\.\.\.DISABLED_BUILTIN_PLUGINS, \.\.\.pluginDirectories, \.\.\.\(contributed\.plugins \?\? \[\]\)\],/, 'the managed config no longer lists upstream\'s plugins before contributed ones');
    const { createManagedConfigRuntime, MANAGED_CONFIG_FILE_NAME } = await importUpstream('packages/web/server/lib/opencode/managed-config-file.js');
    const dataDir = tempDir(t, 'contract-plugin-order-');
    const runtime = createManagedConfigRuntime({
      fsPromises: fs.promises,
      path,
      dataDir,
      env: {},
      agentToolRuntime: { materializePlugin: async () => '/upstream/acme-agent-tool', createChildEnv: () => ({}) },
      readSettings: async () => ({}),
      isAgentMemoryAvailable: () => false,
      contributeConfig: async () => ({ plugins: ['/plugins/acme-tools'] }),
    });
    const order = () => JSON.parse(fs.readFileSync(path.join(dataDir, MANAGED_CONFIG_FILE_NAME), 'utf8')).plugins.filter((entry) => entry.startsWith('/'));
    await runtime.buildManagedChildEnv();
    assert.deepEqual(order(), ['/upstream/acme-agent-tool', '/plugins/acme-tools']);
    await runtime.refreshManagedConfigFile();
    assert.deepEqual(order(), ['/upstream/acme-agent-tool', '/plugins/acme-tools']);
  },

  'session-idle-aborted-event': async () => {
    const { translateWireEvent } = await importUpstream('packages/web/server/lib/event-stream/translate-v2.js');
    const idle = translateWireEvent({ id: 'evt_1', type: 'session.execution.interrupted', data: { sessionID: 'ses_1', reason: 'user' } }).find((event) => event.type === 'session.idle');
    assert.equal(idle?.properties?.aborted, true, 'an interrupted turn no longer arrives as session.idle with aborted');
    assert.equal(idle.properties.sessionID, 'ses_1');
    const finished = translateWireEvent({ id: 'evt_2', type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } }).find((event) => event.type === 'session.idle');
    assert.equal(finished?.properties?.aborted, undefined, 'a finished turn now reads as aborted');
    has(source('packages/web/server/lib/event-stream/global-hub.js'), /translated\(\) \{\s*translated \?\?= translateWireEvent\(payload\);\s*return translated;\s*\},/, 'hub subscribers no longer get translated()');
    has(source('packages/web/server/index.js'), /if \(payload\.type === 'session\.idle' && payload\.properties\?\.aborted === true\) \{\s*agentToolRuntime\?\.abortSession\?\.\(payload\.properties\.sessionID\);/, 'upstream\'s agent tool no longer aborts on the same signal');
  },

  'session-deleted-event': async () => {
    const { translateWireEvent } = await importUpstream('packages/web/server/lib/event-stream/translate-v2.js');
    const deleted = translateWireEvent({ id: 'evt_3', type: 'session.deleted', data: { sessionID: 'ses_1' } }).find((event) => event.type === 'session.deleted');
    assert.equal(deleted?.properties?.info?.id, 'ses_1', 'a deleted session no longer arrives as session.deleted with properties.info.id');
    has(source('packages/web/server/lib/event-stream/global-hub.js'), /translated\(\) \{\s*translated \?\?= translateWireEvent\(payload\);\s*return translated;\s*\},/, 'hub subscribers no longer get translated()');
    has(source('packages/web/server/index.js'), /subscribe: \(listener\) => globalMessageStreamHub\.subscribeEvent\(listener\),/, 'the plugin context no longer subscribes plugins to the global event hub');
  },

  'screenshot-directory': async (t) => {
    const screenshots = await importUpstream('packages/web/server/lib/openchamber-control/screenshots.js');
    const { readCapture } = await import('./mittr/tools/screenshots.js');
    assert.equal(screenshots.SCREENSHOT_DIRECTORY, path.join('.openchamber', 'screenshots'), 'the screenshot folder moved');
    const directory = tempDir(t, 'contract-capture-');
    const signatures = {
      'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
      'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]),
      'image/webp': Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP')]),
    };
    for (const [mime, extension] of [['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/webp', '.webp']]) {
      const bytes = signatures[mime];
      const written = await screenshots.writeScreenshot({ directory, base64: bytes.toString('base64'), mime, label: 'Acme Page' });
      assert.ok(written.path.startsWith('.openchamber/screenshots/acme-page-') && written.path.endsWith(extension), `writeScreenshot no longer saves ${mime} as ${extension} under the folder with the label slug: ${written.path}`);
      assert.equal(written.absolutePath, path.join(directory, written.path), 'writeScreenshot no longer saves at the reported path under the project');
      assert.deepEqual(await readCapture({ directory, relativePath: written.path, folder: screenshots.SCREENSHOT_DIRECTORY }), { base64: bytes.toString('base64'), mime }, `a ${mime} capture upstream saved no longer reads back`);
    }
  },

  'web-capture-result': async (t) => {
    const { createOpenChamberControlService } = await importUpstream('packages/web/server/lib/openchamber-control/service.js');
    const { SCREENSHOT_DIRECTORY } = await importUpstream('packages/web/server/lib/openchamber-control/screenshots.js');
    const service = createOpenChamberControlService({ browserControl: { request: async () => ({ base64: Buffer.from('acme').toString('base64'), mime: 'image/png', url: 'http://acme.example.test/' }) } });
    const session = tempDir(t, 'contract-web-session-');
    const elsewhere = tempDir(t, 'contract-web-elsewhere-');
    const own = await service.execute('browser.capture', { label: 'acme' }, session);
    assert.ok(own.path.startsWith(`${SCREENSHOT_DIRECTORY.split(path.sep).join('/')}/acme-`), `a capture no longer answers a project-relative path under the screenshot folder: ${own.path}`);
    assert.equal(Object.hasOwn(own, 'base64'), false, 'a capture now answers its image bytes');
    assert.ok(fs.existsSync(path.join(session, own.path)), 'a capture is no longer saved under the session directory');
    const other = await service.execute('browser.capture', { directory: elsewhere }, session);
    assert.ok(fs.existsSync(path.join(elsewhere, other.path)) && !fs.existsSync(path.join(session, other.path)), 'a capture no longer saves under the directory the input names');

    const runtime = source('packages/web/server/lib/agent-tool/runtime.js');
    has(runtime, /name: 'openchamber_web',/, 'the panel tool is no longer openchamber_web');
    has(runtime, /if \(valid\) return \{ content, metadata: \{ openchamber: /, 'the agent tool no longer returns its envelope as text content');
    has(runtime, /const args = \{ \.\.\.flattened, \.\.\.\(parameters \?\? \{\}\), action: requestedAction \}/, 'the agent tool no longer merges flattened inputs under parameters');
    const managed = source('packages/web/server/lib/opencode/managed-config-file.js');
    has(managed, /const includeWeb = settings\?\.agentWebToolEnabled !== false;/, 'the web tool is no longer on unless set false');
    has(managed, /directories\.push\(await agentToolRuntime\.materializePlugin\(\{ includeControl, includeWeb, includeMemory, includeNotify, codeMode \}\)\);/, 'the panel tool no longer comes from the agent tool plugin in upstream\'s own plugin directories');
    has(managed, /plugins: \[\.\.\.DISABLED_BUILTIN_PLUGINS, \.\.\.pluginDirectories, \.\.\.\(contributed\.plugins \?\? \[\]\)\],/, 'upstream\'s agent tool plugin no longer comes before the MittrCraft tools plugin, so tools.get may not find openchamber_web');
    const settingsRuntime = source('packages/web/server/lib/opencode/settings-runtime.js');
    const managedKeys = settingsRuntime.slice(settingsRuntime.indexOf('const MANAGED_PLUGIN_SETTINGS_KEYS = new Set(['), settingsRuntime.indexOf(']);', settingsRuntime.indexOf('const MANAGED_PLUGIN_SETTINGS_KEYS')));
    assert.ok(managedKeys.includes("'agentWebToolEnabled'"), 'a change of agentWebToolEnabled no longer rewrites the managed config');
  },

  'permission-never-auto-answer': async (t) => {
    const { createPermissionAutoAcceptRuntime } = await importUpstream('packages/web/server/lib/permission-auto-accept/runtime.js');
    const { loadServerPlugins } = await importUpstream('packages/web/server/lib/server-plugins.js');
    const plugin = path.join(tempDir(t, 'contract-never-auto-'), 'mark.mjs');
    fs.writeFileSync(plugin, 'export default () => ({ neverAutoAnswer: (permission) => permission?.action === "mittrcraft_chrome" });');
    const plugins = await loadServerPlugins({ specifiers: [plugin], context: { app: {}, dataDir: '/data', logger: console } });
    let listener = null;
    const fetched = [];
    const broadcasts = [];
    const asked = [];
    const runtime = createPermissionAutoAcceptRuntime({
      globalEventHub: { subscribeEvent: (next) => { listener = next; return () => {}; }, subscribeStatus: () => () => {} },
      buildOpenCodeUrl: (route) => `http://engine.example.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      readSettingsFromDiskMigrated: async () => ({ permissionAutoAccept: { sessions: { fast: 'auto', careful: 'safety' } } }),
      persistSettings: async () => {},
      broadcastGlobalUiEvent: (event) => broadcasts.push(event),
      evaluatePermission: async (permission) => {
        asked.push(permission.id);
        return { action: 'accept' };
      },
      neverAutoAnswer: (permission) => plugins.neverAutoAnswer(permission) === true,
      fetchImpl: async (url) => {
        fetched.push(String(url));
        return new Response('[]');
      },
      retryDelaysMs: [0],
    });
    runtime.start();
    await runtime.load();
    for (const [id, sessionID] of [['per_fast', 'fast'], ['per_careful', 'careful']]) {
      const payload = { type: 'permission.asked', properties: { id, sessionID, action: 'mittrcraft_chrome', resources: ['acme.example.test'] } };
      listener({ payload, directory: '/project', translated: () => [payload] });
    }
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    assert.deepEqual(fetched.filter((url) => url.includes('/reply')), [], 'a marked request was answered automatically');
    assert.deepEqual(asked, [], 'the safety classifier was asked about a marked request');
    assert.deepEqual(broadcasts.filter((event) => event.type === 'openchamber:permission-auto-accept.left-for-user').map((event) => event.properties.permissionId).sort(), ['per_careful', 'per_fast'], 'a marked request is no longer announced as left for the user');
    assert.equal(await runtime.isPermissionAutoAnswered('fast', '/project', 'per_fast'), false, 'a marked request in an auto session counts as answered automatically');
    has(source('packages/web/server/index.js'), /neverAutoAnswer: \(permission\) => serverPlugins\?\.neverAutoAnswer\?\.\(permission\) === true,/, 'the server no longer hands the plugins\' neverAutoAnswer to the auto-accept runtime');
  },

  'permission-event-shape': async () => {
    const { translateWireEvent } = await importUpstream('packages/web/server/lib/event-stream/translate-v2.js');
    const asked = translateWireEvent({ id: 'evt_1', type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_1', action: 'mittrcraft_chrome', resources: ['acme.example.test'], save: ['acme.example.test'], metadata: { host: 'acme.example.test' } } })
      .find((event) => event.type === 'permission.asked');
    assert.deepEqual(
      { id: asked?.properties?.id, sessionID: asked?.properties?.sessionID, action: asked?.properties?.action, resources: asked?.properties?.resources },
      { id: 'per_1', sessionID: 'ses_1', action: 'mittrcraft_chrome', resources: ['acme.example.test'] },
      'the translated permission.asked no longer keeps id, sessionID, action and resources',
    );
    const replied = translateWireEvent({ id: 'evt_2', type: 'permission.replied', data: { sessionID: 'ses_1', requestID: 'per_1', reply: 'always' } })
      .find((event) => event.type === 'permission.replied');
    assert.equal(replied?.properties?.requestID, 'per_1', 'the translated permission.replied no longer carries requestID');
    assert.equal(Object.hasOwn(replied?.properties ?? {}, 'reply'), false, 'the translated permission.replied now carries the reply; the raw read may be simplified');
    const { Permission } = await import(pathToFileURL(path.join(repoRoot, 'node_modules/@opencode/schema/dist/permission.js')).href);
    assert.equal(Permission.Event.Replied.type, 'permission.replied');
    assert.deepEqual(Object.keys(Permission.Event.Replied.fields.data.fields).sort(), ['reply', 'requestID', 'sessionID'], 'the raw permission.replied data no longer carries reply, requestID and sessionID');
    assert.deepEqual([...Permission.Reply.literals].sort(), ['always', 'once', 'reject'], 'a permission reply is no longer once, always or reject');
    has(source('packages/web/server/lib/event-stream/global-hub.js'), /return \{\s*envelope,\s*payload,\s*directory,/, 'hub subscribers no longer get the raw payload');
  },

  'engine-permission-api': () => {
    const { opencodeCli } = JSON.parse(source('packages/electron/package.json'));
    assert.equal(opencodeCli?.version, '2.0.22', 'the bundled engine moved: run probe P15 and P16 again, then update the Chrome site question and this pin');
    const dist = path.join(repoRoot, 'node_modules/@opencode/client/dist/chunks');
    const chunks = fs.readdirSync(dist).filter((name) => name.endsWith('.js')).map((name) => fs.readFileSync(path.join(dist, name), 'utf8')).join('\n');
    const routes = [
      [/method: "POST",\s*path: `\/api\/session\/\$\{encodeURIComponent\(input\.sessionID\)\}\/permission`,\s*body: \{\s*id: input\["id"\],\s*action: input\["action"\],\s*resources: input\["resources"\],\s*save: input\["save"\],\s*metadata: input\["metadata"\],\s*source: input\["source"\],/, 'POST /api/session/:id/permission with action, resources, save, metadata and source'],
      [/method: "POST",\s*path: `\/api\/session\/\$\{encodeURIComponent\(input\.sessionID\)\}\/permission\/\$\{encodeURIComponent\(input\.requestID\)\}\/reply`,\s*body: \{ decision: input\["decision"\], message: input\["message"\] \},\s*successStatus: 204,/, 'POST /api/session/:id/permission/:requestID/reply with { decision } and 204'],
      [/method: "GET",\s*path: `\/api\/session\/\$\{encodeURIComponent\(input\.sessionID\)\}\/permission`,/, 'GET /api/session/:id/permission'],
      [/method: "GET",\s*path: `\/api\/permission\/saved`,/, 'GET /api/permission/saved'],
      [/method: "DELETE",\s*path: `\/api\/permission\/saved\/\$\{encodeURIComponent\(input\.id\)\}`,\s*successStatus: 204,/, 'DELETE /api/permission/saved/:id with 204'],
      [/method: "POST",\s*path: `\/api\/session\/\$\{encodeURIComponent\(input\.sessionID\)\}\/interrupt`,/, 'POST /api/session/:id/interrupt'],
    ];
    for (const [route, name] of routes) assert.ok(route.test(chunks), `the generated client no longer has ${name}`);
  },

  'settings-section-primitives': () => {
    const section = source('packages/ui/src/components/sections/shared/SettingsSection.tsx');
    for (const name of ['SettingsSection', 'SettingsCheckboxRow', 'SettingsFieldRow']) {
      has(section, new RegExp(`^export const ${name}: React\\.FC<${name}Props> = \\(\\{`, 'm'), `${name} is no longer exported from SettingsSection`);
    }
    for (const name of ['SETTINGS_HELPER_CLASS', 'SETTINGS_OPTION_STACK_CLASS', 'SETTINGS_SELECT_ROW_TRIGGER_CLASS', 'SETTINGS_SELECT_SIZE']) {
      has(section, new RegExp(`^export const ${name} = `, 'm'), `${name} is no longer exported from SettingsSection`);
    }
    has(section, /interface SettingsSectionProps \{[\s\S]*?title\?: React\.ReactNode;[\s\S]*?info\?: React\.ReactNode;[\s\S]*?children: React\.ReactNode;/, 'SettingsSection no longer takes title, info and children');
    has(section, /typeof title === 'string' \|\| typeof title === 'number' \? \(\s*<h2 className=\{SETTINGS_SECTION_TITLE_CLASS\}>\{title\}<\/h2>/, 'SettingsSection no longer draws a string title as its h2');
    has(section, /\{info != null \? <SettingsInfoHint>\{info\}<\/SettingsInfoHint> : null\}/, 'SettingsSection no longer puts info behind the info hint');
    has(source('packages/ui/src/components/ui/index.ts'), /^export \{ toast \} from '\.\/toast'/m, 'components/ui no longer exports toast');
    has(source('packages/ui/src/lib/i18n/messages/en.ts'), /^  'common\.loading': '[^']+',$/m, 'the English dictionary no longer has common.loading');
    has(section, /interface SettingsCheckboxRowProps \{\s*checked: boolean;\s*onChange: \(checked: boolean\) => void;\s*label: React\.ReactNode;\s*description\?: React\.ReactNode;\s*disabled\?: boolean;\s*ariaLabel\?: string;[\s\S]*?info\?: React\.ReactNode;\s*\}/, 'SettingsCheckboxRow no longer takes checked, onChange, label, description, ariaLabel and info');
    has(section, /interface SettingsFieldRowProps \{\s*label: React\.ReactNode;\s*description\?: React\.ReactNode;[\s\S]*?info\?: React\.ReactNode;/, 'SettingsFieldRow no longer takes label and info');
    const select = source('packages/ui/src/components/ui/select.tsx');
    has(select, /export \{\s*Select,\s*SelectContent,[\s\S]*?SelectItem,[\s\S]*?SelectTrigger,\s*SelectValue,\s*\}/, 'select.tsx no longer exports Select, SelectContent, SelectItem, SelectTrigger and SelectValue');
    has(select, /children\?: React\.ReactNode \| \(\(value: string \| undefined\) => React\.ReactNode\);/, 'SelectValue no longer takes a render function of the chosen value');
    has(select, /size\?: "sm" \| "default" \| "lg" \| "chip" \| "settings"/, 'SelectTrigger no longer has the settings size');
    const button = source('packages/ui/src/components/ui/button.tsx');
    has(button, /^export \{ Button \}/m, 'Button is no longer exported');
    for (const variant of ['ghost', 'outline']) has(button, new RegExp(`^\\s+${variant}:`, 'm'), `Button lost its ${variant} variant`);
    has(button, /^\s+sm:/m, 'Button lost its sm size');
  },

  'engine-tool-plugin-api': () => {
    const { opencodeCli } = JSON.parse(source('packages/electron/package.json'));
    assert.equal(opencodeCli?.version, '2.0.22', 'the bundled engine moved: run probe P13 to P18 again, then update the MittrCraft tools plugin and this pin');
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

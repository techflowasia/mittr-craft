import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { engineBases } from './engine-home.js';
import { fakeEngineContext, listen, serve, until } from './mittr/test-helpers.js';
import { mintLocalToken } from './mittr/local-token.js';
import setup, { setupMittrServer } from './plugin.js';
import { LDAP_ENV } from './ui-auth/test-fixtures.js';

const ACCOUNT = '0123456789abcdef';

const SERVER_ONLY_SECRETS = [
  'OPENCHAMBER_UI_PASSWORD',
  'MITTRCRAFT_UI_PASSWORD',
  'OPENCODE_UI_PASSWORD',
  'OPENCODE_JWT_SECRET',
  'OPENCHAMBER_TUNNEL_TOKEN',
  'NGROK_AUTHTOKEN',
  'OPENCHAMBER_APNS_P8',
  'OPENCHAMBER_APNS_KEY_ID',
  'OPENCHAMBER_APNS_TEAM_ID',
  'OPENCHAMBER_LINEAR_CLIENT_SECRET',
  'OPENCHAMBER_JEV_API_KEY',
  'JIRA_TOKEN',
  'PLANE_API_KEY',
];

const tempHome = (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-plugin-')));
  t.after(() => {
    const share = path.join(home, '.local', 'share', 'mittrcraft');
    if (fs.existsSync(share)) fs.chmodSync(share, 0o755);
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
};

const writeFile = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

const recordingLogger = () => {
  const lines = [];
  return { lines, log: (...args) => lines.push(args.join(' ')), warn: (...args) => lines.push(args.join(' ')), error: (...args) => lines.push(args.join(' ')) };
};

const prodLayout = (home) => {
  const dataDir = path.join(home, '.config', 'mittrcraft');
  writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ desktopLocalPort: 57123, voiceStepCap: 3 }));
  writeFile(path.join(dataDir, 'speech-models', 'model.bin'), 'weights');
  writeFile(path.join(dataDir, 'engine', 'opencode', 'opencode.json'), '{}');
  writeFile(path.join(home, '.local', 'share', 'mittrcraft', 'engine', 'opencode', 'opencode.db'), 'sessions');
  writeFile(
    path.join(home, '.local', 'share', 'mittrcraft', 'engine', 'accounts', ACCOUNT, 'opencode', 'opencode.db'),
    'second account',
  );
  return dataDir;
};

test('setup backs up the prod layout once, migrates settings and serves the engine env', async (t) => {
  const home = tempHome(t);
  const dataDir = prodLayout(home);
  const logger = recordingLogger();

  const plugin = await setupMittrServer({ dataDir, logger, env: {}, homeDir: home });

  const shareBackup = path.join(home, '.local', 'share', 'mittrcraft', 'engine.pre-2x-backup');
  assert.equal(fs.readFileSync(path.join(shareBackup, 'opencode', 'opencode.db'), 'utf8'), 'sessions');
  assert.equal(
    fs.readFileSync(path.join(shareBackup, 'accounts', ACCOUNT, 'opencode', 'opencode.db'), 'utf8'),
    'second account',
  );
  const dataBackup = `${dataDir}.pre-2x-backup`;
  assert.equal(fs.existsSync(path.join(dataBackup, 'engine', 'opencode', 'opencode.json')), true);
  assert.equal(fs.existsSync(path.join(dataBackup, 'speech-models')), false);
  assert.equal(fs.existsSync(path.join(dataDir, '.pre-2x-backup-done')), true);
  for (const where of [shareBackup, dataBackup]) {
    assert.equal(logger.lines.filter((line) => line.includes(where)).length, 1, where);
  }

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')), {
    desktopLocalPort: 57123,
    mittr: { voiceStepCap: 3 },
  });

  assert.deepEqual(await plugin.engineEnv(), {
    XDG_CONFIG_HOME: path.join(home, '.config', 'mittrcraft', 'engine'),
    XDG_DATA_HOME: path.join(home, '.local', 'share', 'mittrcraft', 'engine', 'accounts', '_none'),
    XDG_STATE_HOME: path.join(home, '.local', 'state', 'mittrcraft', 'engine', 'accounts', '_none'),
    XDG_CACHE_HOME: path.join(home, '.cache', 'mittrcraft', 'engine'),
    OPENCODE_DB: 'opencode.db',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    ...Object.fromEntries(['MITTR_AD_CLIENT_SECRET', 'MITTR_AD_BIND_PASSWORD', ...SERVER_ONLY_SECRETS].map((name) => [name, undefined])),
  });

  writeFile(
    path.join(dataDir, 'mittr-accounts', 'index.json'),
    JSON.stringify({
      active: 'user-second',
      accounts: [
        { userId: 'user-first', displayName: 'First', home: null, signedIn: true },
        { userId: 'user-second', displayName: 'Second', home: ACCOUNT, signedIn: true },
      ],
    }),
  );
  const switched = await plugin.engineEnv();
  assert.equal(switched.XDG_DATA_HOME, path.join(home, '.local', 'share', 'mittrcraft', 'engine', 'accounts', ACCOUNT));
  assert.equal(switched.XDG_STATE_HOME, path.join(home, '.local', 'state', 'mittrcraft', 'engine', 'accounts', ACCOUNT));

  const again = recordingLogger();
  await setupMittrServer({ dataDir, logger: again, env: {}, homeDir: home });
  assert.equal(again.lines.some((line) => line.includes('pre-2x-backup')), false);
});

test('the first engine start puts the app\'s bundled rg in the engine cache, so the engine never downloads one, and later starts do not check it again', async (t) => {
  const home = tempHome(t);
  const dataDir = prodLayout(home);
  const resourcesDir = path.join(home, 'MittrCraft.app', 'Contents', 'Resources');
  writeFile(path.join(resourcesDir, 'ripgrep', 'rg'), 'bundled rg');

  const plugin = await setupMittrServer({ dataDir, logger: recordingLogger(), env: {}, homeDir: home, resourcesDir });
  const env = await plugin.engineEnv();
  const engineRg = path.join(env.XDG_CACHE_HOME, 'opencode', 'bin', 'rg');
  assert.equal(fs.readFileSync(engineRg, 'utf8'), 'bundled rg');
  assert.equal(env.PATH, undefined);

  fs.rmSync(path.dirname(engineRg), { recursive: true });
  await plugin.engineEnv();
  assert.equal(fs.existsSync(engineRg), false);

  const nextRun = await setupMittrServer({ dataDir, logger: recordingLogger(), env: {}, homeDir: home, resourcesDir });
  await nextRun.engineEnv();
  assert.equal(fs.readFileSync(engineRg, 'utf8'), 'bundled rg');
});

test('a bundled rg that could not be placed is tried again on each start until it is, and warned about once', async (t) => {
  const home = tempHome(t);
  const dataDir = prodLayout(home);
  const resourcesDir = path.join(home, 'MittrCraft.app', 'Contents', 'Resources');
  writeFile(path.join(resourcesDir, 'ripgrep', 'rg'), 'bundled rg');
  const logger = recordingLogger();
  const plugin = await setupMittrServer({ dataDir, logger, env: {}, homeDir: home, resourcesDir });
  const engineRg = path.join(engineBases({ homeDir: home, env: {} }).cache, 'opencode', 'bin', 'rg');
  writeFile(path.dirname(engineRg), 'not a folder');

  assert.equal((await plugin.engineEnv()).OPENCODE_DISABLE_MODELS_FETCH, '1');
  await plugin.engineEnv();
  await plugin.engineEnv();
  assert.equal(logger.lines.filter((line) => line.includes('[mittr] could not put the bundled rg')).length, 1);

  fs.rmSync(path.dirname(engineRg));
  await plugin.engineEnv();
  assert.equal(fs.readFileSync(engineRg, 'utf8'), 'bundled rg');
});

test('setup on the Dev layout backs up the data dir once, with the engine inside it', async (t) => {
  const home = tempHome(t);
  const dataDir = path.join(home, '.config', 'mittrcraft-dev');
  const engineHome = path.join(dataDir, 'engine');
  writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ desktopLocalPort: 57123 }));
  writeFile(path.join(engineHome, 'opencode', 'opencode.db'), 'sessions');

  const plugin = await setupMittrServer({
    dataDir,
    logger: recordingLogger(),
    env: { MITTRCRAFT_ENGINE_HOME: engineHome },
    homeDir: home,
  });

  assert.equal(
    fs.readFileSync(path.join(`${dataDir}.pre-2x-backup`, 'engine', 'opencode', 'opencode.db'), 'utf8'),
    'sessions',
  );
  assert.equal(fs.existsSync(`${engineHome}.pre-2x-backup`), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).desktopLocalPort, 57123);
  const env = await plugin.engineEnv();
  for (const key of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) assert.equal(env[key], engineHome, key);
  for (const key of ['XDG_DATA_HOME', 'XDG_STATE_HOME']) assert.equal(env[key], path.join(engineHome, 'accounts', '_none'), key);
});

test('setup refuses a Dev data dir without its own engine root', async (t) => {
  const home = tempHome(t);
  const dataDir = path.join(home, '.config', 'mittrcraft-dev');
  writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ voiceStepCap: 1 }));
  writeFile(path.join(home, '.local', 'share', 'mittrcraft', 'engine', 'opencode', 'opencode.db'), 'prod sessions');

  for (const env of [{}, { MITTRCRAFT_ENGINE_HOME: '  ' }]) {
    await assert.rejects(
      setupMittrServer({ dataDir, logger: recordingLogger(), env, homeDir: home }),
      /MITTRCRAFT_ENGINE_HOME/,
    );
  }
  assert.deepEqual(fs.readdirSync(path.join(home, '.local', 'share', 'mittrcraft')), ['engine']);
  assert.deepEqual(fs.readdirSync(path.join(home, '.config')), ['mittrcraft-dev']);
  assert.deepEqual(fs.readdirSync(dataDir), ['settings.json']);
});

test('setup rejects when backup copy fails', async (t) => {
  const home = tempHome(t);
  const dataDir = prodLayout(home);
  fs.chmodSync(path.join(home, '.local', 'share', 'mittrcraft'), 0o555);

  await assert.rejects(
    setupMittrServer({ dataDir, logger: recordingLogger(), env: {}, homeDir: home }),
    /pre-2x-backup/,
  );
  assert.equal(fs.existsSync(path.join(dataDir, '.pre-2x-backup-done')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')), {
    desktopLocalPort: 57123,
    voiceStepCap: 3,
  });
});

test('setup goes on when settings cannot be migrated, and tries again next start', async (t) => {
  const home = tempHome(t);
  const dataDir = prodLayout(home);
  fs.writeFileSync(path.join(dataDir, 'settings.json'), '{"broken": ');
  const logger = recordingLogger();

  const plugin = await setupMittrServer({ dataDir, logger, env: {}, homeDir: home });

  assert.ok(plugin.engineEnv instanceof Function);
  assert.equal(logger.lines.some((line) => line.includes('settings')), true);
  assert.equal(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'), '{"broken": ');
});

test('setup with the server context mounts Mittr sign-in and keeps the engine env', async (t) => {
  const home = tempHome(t);
  const dataDir = prodLayout(home);
  const app = express();
  const logger = recordingLogger();
  const plugin = await setupMittrServer({
    dataDir,
    logger,
    env: { MITTRCRAFT_BROKER_URL: 'https://api.mittr.asia', MITTRCRAFT_BROKER_FIXED: '1', MITTRCRAFT_DEEP_LINK_SCHEME: 'mittrcraft' },
    homeDir: home,
    context: { app, express, dataDir, logger, host: null, ...fakeEngineContext({ port: null }).context },
  });

  const { status, body } = await (await serve(t, app))('POST', '/api/mittr/auth/start');
  assert.equal(status, 200);
  assert.ok(body.authorizeUrl.startsWith('https://api.mittr.asia/auth/desktop/start?code_challenge='), body.authorizeUrl);
  assert.ok(body.authorizeUrl.includes('redirect_uri=mittrcraft%3A%2F%2Fauth%2Fcallback'), body.authorizeUrl);
  assert.equal((await plugin.engineEnv()).XDG_DATA_HOME, path.join(home, '.local', 'share', 'mittrcraft', 'engine', 'accounts', '_none'));
  assert.equal((await plugin.engineEnv()).NO_PROXY.split(',').includes('127.0.0.1'), true);
  assert.equal((await plugin.engineEnv()).OPENCODE_DISABLE_MODELS_FETCH, '1');
  assert.equal((await plugin.engineEnv()).OPENCODE_DISABLE_AUTOUPDATE, '1');
  assert.deepEqual(await plugin.managedConfig(), {
    plugins: [path.join(dataDir, 'engine-plugins', 'mittrcraft-identity')],
    share: 'disabled',
    experimental: {
      policies: [
        { action: 'provider.use', resource: '*', effect: 'deny' },
        { action: 'provider.use', resource: 'mittr', effect: 'allow' },
      ],
    },
  });
  await plugin.dispose();
});

test('the engine env names the tools callback, and reading it again mints nothing', async (t) => {
  const home = tempHome(t);
  const dataDir = prodLayout(home);
  const engine = fakeEngineContext({ port: 4100 });
  const plugin = await setupMittrServer({
    dataDir,
    logger: recordingLogger(),
    env: {},
    homeDir: home,
    context: { app: express(), express, dataDir, logger: recordingLogger(), host: null, ...engine.context },
  });
  t.after(() => plugin.dispose());

  const first = await plugin.engineEnv();
  assert.equal(first.MITTRCRAFT_TOOLS_URL, 'http://127.0.0.1:4100/mittr-tools/v1/call');
  assert.match(first.MITTRCRAFT_TOOLS_TOKEN, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await plugin.engineEnv()).MITTRCRAFT_TOOLS_TOKEN, first.MITTRCRAFT_TOOLS_TOKEN);
});

test('setup with the server context serves the hosted web UI with the MittrCraft brand', async (t) => {
  const home = tempHome(t);
  const dataDir = prodLayout(home);
  const dist = path.join(home, 'web-dist');
  writeFile(path.join(dist, 'index.html'), '<html><head><title>OpenChamber - AI Coding Assistant</title></head></html>');
  const app = express();
  const logger = recordingLogger();
  const plugin = await setupMittrServer({
    dataDir,
    logger,
    env: { OPENCHAMBER_DIST_DIR: dist, MITTRCRAFT_BROKER_URL: 'https://api.mittr.asia', MITTRCRAFT_BROKER_FIXED: '1', MITTRCRAFT_DEEP_LINK_SCHEME: 'mittrcraft' },
    homeDir: home,
    context: { app, express, dataDir, logger, host: null, ...fakeEngineContext({ port: null }).context },
  });
  t.after(() => plugin.dispose());
  app.use(express.static(dist));

  const page = await fetch(`${await listen(t, app)}/`);
  assert.equal(await page.text(), '<html><head><title>MittrCraft - AI Coding Assistant</title></head></html>');
});

const ENTRA_ENV = {
  MITTR_AD_CLIENT_ID: 'client-app-id',
  MITTR_AD_CLIENT_SECRET: 'entra-client-secret-value',
  MITTR_AD_TENANT_ID: '11111111-2222-3333-4444-555555555555',
  MITTR_AD_REDIRECT_URI: 'https://mittrcraft.example.test/auth/ad/callback',
};

const uiAuthContext = () => {
  const registered = [];
  return {
    registered,
    uiAuth: {
      registerProvider: ({ id }) => {
        registered.push(id);
        return { issueSession: async () => {}, readClaims: async () => null, clearSession: () => {}, unregister: () => registered.splice(registered.indexOf(id), 1) };
      },
      passwordEnabled: () => false,
    },
  };
};

test('setup with Microsoft sign-in configured requires it for browser sessions', async (t) => {
  const home = tempHome(t);
  const dataDir = prodLayout(home);
  const app = express();
  const logger = recordingLogger();
  const { registered, uiAuth } = uiAuthContext();
  const plugin = await setupMittrServer({
    dataDir,
    logger,
    env: { ...ENTRA_ENV, MITTRCRAFT_BROKER_URL: 'https://api.mittr.asia', MITTRCRAFT_BROKER_FIXED: '1', MITTRCRAFT_DEEP_LINK_SCHEME: 'mittrcraft' },
    homeDir: home,
    context: { app, express, dataDir, logger, host: null, requestScope: () => 'local', uiAuth, ...fakeEngineContext({ port: null }).context },
  });

  assert.deepEqual(registered, ['ad']);
  const { status, body } = await (await serve(t, app))('GET', '/auth/ad/status');
  assert.equal(status, 200);
  assert.deepEqual(body, { enabled: true, mode: 'entra', passwordEnabled: false, tunnelLocked: false });
  assert.ok(logger.lines.some((line) => line.includes('company sign-in (entra)')));
  assert.ok(!logger.lines.some((line) => line.includes(ENTRA_ENV.MITTR_AD_CLIENT_SECRET)));
  await plugin.dispose();
  assert.deepEqual(registered, []);
});

test('a desktop server that requires company sign-in keeps the catalog connectors off, and one that does not keeps them on', async (t) => {
  const offLine = '[mittr] catalog connectors are off on hosted web until an administrator decides how their secrets are protected';
  for (const [signInEnv, expected] of [[ENTRA_ENV, 1], [{}, 0]]) {
    const home = tempHome(t);
    const dataDir = prodLayout(home);
    const logger = recordingLogger();
    const { uiAuth } = uiAuthContext();
    const host = { secretStore: { encrypt: (text) => Buffer.from(text), decrypt: (data) => Buffer.from(data).toString() }, deepLinks: { register: () => () => {} } };
    const plugin = await setupMittrServer({
      dataDir,
      logger,
      env: { ...signInEnv, MITTRCRAFT_BROKER_URL: 'https://api.mittr.asia', MITTRCRAFT_BROKER_FIXED: '1', MITTRCRAFT_DEEP_LINK_SCHEME: 'mittrcraft' },
      homeDir: home,
      context: { app: express(), express, dataDir, logger, host, requestScope: () => 'local', uiAuth, ...fakeEngineContext({ port: null }).context },
    });
    assert.equal(logger.lines.filter((line) => line === offLine).length, expected);
    await plugin.dispose();
  }
});

test('setup with partial Microsoft settings refuses to start', async (t) => {
  const home = tempHome(t);
  const dataDir = prodLayout(home);
  const logger = recordingLogger();
  const { registered, uiAuth } = uiAuthContext();
  const { MITTR_AD_CLIENT_SECRET, ...partial } = ENTRA_ENV;
  assert.ok(MITTR_AD_CLIENT_SECRET);

  await assert.rejects(setupMittrServer({
    dataDir,
    logger,
    env: { ...partial, MITTRCRAFT_BROKER_URL: 'https://api.mittr.asia', MITTRCRAFT_BROKER_FIXED: '1', MITTRCRAFT_DEEP_LINK_SCHEME: 'mittrcraft' },
    homeDir: home,
    context: { app: express(), express, dataDir, logger, host: null, requestScope: () => 'local', uiAuth, ...fakeEngineContext({ port: null }).context },
  }), /Missing MITTR_AD_CLIENT_SECRET/);
  assert.deepEqual(registered, []);
});

const companySignInNames = (env) => Object.keys(env).filter((name) => name.startsWith('MITTR_AD_')).sort();

const namesSeenByChild = (env) => {
  const child = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(Object.keys(process.env)))'], { env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  return companySignInNames(Object.fromEntries(JSON.parse(child.stdout).map((name) => [name, ''])));
};

for (const [mode, signInEnv] of [['entra', { ...ENTRA_ENV, MITTR_AD_BIND_PASSWORD: 'service-account-secret' }], ['ldap', LDAP_ENV]]) {
  test(`company sign-in (${mode}) settings are read once and kept out of every engine start`, async (t) => {
    const home = tempHome(t);
    const dataDir = prodLayout(home);
    const app = express();
    const logger = recordingLogger();
    const { registered, uiAuth } = uiAuthContext();
    const env = { ...signInEnv, PATH: process.env.PATH, MITTRCRAFT_BROKER_URL: 'https://api.mittr.asia', MITTRCRAFT_BROKER_FIXED: '1', MITTRCRAFT_DEEP_LINK_SCHEME: 'mittrcraft' };
    const plugin = await setupMittrServer({
      dataDir,
      logger,
      env,
      homeDir: home,
      context: { app, express, dataDir, logger, host: null, requestScope: () => 'local', uiAuth, ...fakeEngineContext({ port: null }).context },
    });
    t.after(() => plugin.dispose());

    assert.deepEqual(registered, ['ad']);
    const { body } = await (await serve(t, app))('GET', '/auth/ad/status');
    assert.deepEqual(body, { enabled: true, mode, passwordEnabled: false, tunnelLocked: false });
    assert.deepEqual(companySignInNames(env), []);

    const engineEnv = await plugin.engineEnv();
    for (const name of Object.keys(signInEnv)) {
      assert.ok(Object.hasOwn(engineEnv, name), name);
      assert.equal(engineEnv[name], undefined, name);
    }
    const loginShell = { ...signInEnv };
    assert.deepEqual(namesSeenByChild({ ...loginShell, ...env, ...engineEnv }), []);
  });
}

test('without the server context, company sign-in settings still never reach the engine', async (t) => {
  const home = tempHome(t);
  const dataDir = prodLayout(home);
  const env = { ...ENTRA_ENV, PATH: process.env.PATH };

  const plugin = await setupMittrServer({ dataDir, logger: recordingLogger(), env, homeDir: home });

  assert.deepEqual(companySignInNames(env), []);
  assert.deepEqual(namesSeenByChild({ ...ENTRA_ENV, ...env, ...(await plugin.engineEnv()) }), []);
});

test('a company sign-in variable that turns up after setup is withheld from the engine by its name', async (t) => {
  for (const context of [null, { app: express(), express, logger: recordingLogger(), host: null, ...fakeEngineContext({ port: null }).context }]) {
    const home = tempHome(t);
    const dataDir = prodLayout(home);
    const env = { PATH: process.env.PATH, MITTRCRAFT_DEEP_LINK_SCHEME: 'mittrcraft' };
    const plugin = await setupMittrServer({ dataDir, logger: recordingLogger(), env, homeDir: home, context: context && { ...context, dataDir } });
    t.after(() => plugin.dispose?.());

    env.MITTR_AD_LATE_SECRET = 'late-value';
    const engineEnv = await plugin.engineEnv();
    assert.ok(Object.hasOwn(engineEnv, 'MITTR_AD_LATE_SECRET') && engineEnv.MITTR_AD_LATE_SECRET === undefined);
    assert.deepEqual(namesSeenByChild({ ...env, ...engineEnv }), []);
  }
});

const ENGINE_KEEPS = {
  OPENCHAMBER_AGENT_TOOL_TOKEN: 'agent-tool-token',
  OPENCHAMBER_AGENT_TOOL_URL: 'http://127.0.0.1:1/agent-tool',
  OPENCODE_PASSWORD: 'engine-password',
  OPENCODE_SERVER_PASSWORD: 'engine-password',
  OPENAI_API_KEY: 'provider-key',
  MITTRCRAFT_BROKER_URL: 'https://api.mittr.asia',
  MITTRCRAFT_BROKER_FIXED: '1',
};

const seenByChild = (env, names) => {
  const child = spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(${JSON.stringify(names)}.filter((name) => name in process.env)))`], { env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
};

test('the server\'s own secrets stay with the server and out of every engine start, and what the engine needs reaches it', async (t) => {
  const home = tempHome(t);
  const dataDir = prodLayout(home);
  const secrets = Object.fromEntries(SERVER_ONLY_SECRETS.map((name) => [name, `value-of-${name.toLowerCase()}`]));
  const env = { ...secrets, ...ENGINE_KEEPS, PATH: process.env.PATH, MITTRCRAFT_DEEP_LINK_SCHEME: 'mittrcraft' };
  const plugin = await setupMittrServer({
    dataDir,
    logger: recordingLogger(),
    env,
    homeDir: home,
    context: { app: express(), express, dataDir, logger: recordingLogger(), host: null, ...fakeEngineContext({ port: null }).context },
  });
  t.after(() => plugin.dispose());

  for (const name of SERVER_ONLY_SECRETS) assert.equal(env[name], secrets[name], `${name} left the server`);
  const engineEnv = await plugin.engineEnv();
  for (const name of SERVER_ONLY_SECRETS) assert.ok(Object.hasOwn(engineEnv, name) && engineEnv[name] === undefined, name);
  const spawned = { ...secrets, ...env, ...engineEnv };
  assert.deepEqual(seenByChild(spawned, SERVER_ONLY_SECRETS), []);
  assert.deepEqual(seenByChild(spawned, Object.keys(ENGINE_KEEPS)), Object.keys(ENGINE_KEEPS));
});

test('the runtime the bin pinned is taken back once the server runs, and one set by hand is left alone', async (t) => {
  const run = async (env) => {
    const home = tempHome(t);
    const plugin = await setupMittrServer({ dataDir: prodLayout(home), logger: recordingLogger(), env, homeDir: home });
    return { env, engineEnv: await plugin.engineEnv() };
  };

  const pinned = await run({ BUN_BINARY: '/opt/node/bin/node', MITTRCRAFT_BIN_BUN_BINARY: '/opt/node/bin/node', PATH: process.env.PATH });
  assert.equal(Object.hasOwn(pinned.env, 'BUN_BINARY'), false);
  assert.equal(Object.hasOwn(pinned.env, 'MITTRCRAFT_BIN_BUN_BINARY'), false);
  for (const name of ['BUN_BINARY', 'MITTRCRAFT_BIN_BUN_BINARY']) assert.ok(Object.hasOwn(pinned.engineEnv, name) && pinned.engineEnv[name] === undefined, name);
  const loginShell = { BUN_BINARY: '/opt/node/bin/node', MITTRCRAFT_BIN_BUN_BINARY: '/opt/node/bin/node' };
  assert.deepEqual(seenByChild({ ...loginShell, ...pinned.env, ...pinned.engineEnv }, ['BUN_BINARY', 'MITTRCRAFT_BIN_BUN_BINARY']), []);

  const own = await run({ BUN_BINARY: '/opt/bun/bin/bun', MITTRCRAFT_BIN_BUN_BINARY: '/opt/node/bin/node' });
  assert.equal(own.env.BUN_BINARY, '/opt/bun/bin/bun');
  assert.equal(Object.hasOwn(own.engineEnv, 'BUN_BINARY'), false);

  const handSet = await run({ BUN_BINARY: '/opt/bun/bin/bun' });
  assert.equal(handSet.env.BUN_BINARY, '/opt/bun/bin/bun');
  assert.equal(Object.hasOwn(handSet.engineEnv, 'BUN_BINARY'), false);
});

const secretFile = (home, name, content) => {
  const file = path.join(home, 'secrets', name);
  writeFile(file, content);
  fs.chmodSync(file, 0o600);
  return file;
};

for (const [mode, plain, fileVariable, secretName] of [
  ['entra', ENTRA_ENV, 'MITTR_AD_CLIENT_SECRET_FILE', 'MITTR_AD_CLIENT_SECRET'],
  ['ldap', LDAP_ENV, 'MITTR_AD_BIND_PASSWORD_FILE', 'MITTR_AD_BIND_PASSWORD'],
]) {
  test(`company sign-in (${mode}) starts with its secret only in ${fileVariable}, and the engine sees neither`, async (t) => {
    const home = tempHome(t);
    const dataDir = prodLayout(home);
    const app = express();
    const { registered, uiAuth } = uiAuthContext();
    const { [secretName]: plainSecret, ...rest } = plain;
    assert.ok(plainSecret);
    const env = { ...rest, [fileVariable]: secretFile(home, 'company-sign-in', 'secret-from-file\n'), PATH: process.env.PATH, MITTRCRAFT_DEEP_LINK_SCHEME: 'mittrcraft' };
    const plugin = await setupMittrServer({
      dataDir,
      logger: recordingLogger(),
      env,
      homeDir: home,
      context: { app, express, dataDir, logger: recordingLogger(), host: null, requestScope: () => 'local', uiAuth, ...fakeEngineContext({ port: null }).context },
    });
    t.after(() => plugin.dispose());

    assert.deepEqual(registered, ['ad']);
    const { body } = await (await serve(t, app))('GET', '/auth/ad/status');
    assert.deepEqual(body, { enabled: true, mode, passwordEnabled: false, tunnelLocked: false });
    assert.deepEqual(companySignInNames(env), []);
    const engineEnv = await plugin.engineEnv();
    for (const name of [fileVariable, secretName]) assert.ok(Object.hasOwn(engineEnv, name) && engineEnv[name] === undefined, name);
  });
}

test('a secret file that cannot be read refuses to start, naming the variable and nothing it holds', async (t) => {
  const home = tempHome(t);
  const dataDir = prodLayout(home);
  const { uiAuth } = uiAuthContext();
  const { MITTR_AD_CLIENT_SECRET, ...rest } = ENTRA_ENV;
  assert.ok(MITTR_AD_CLIENT_SECRET);
  await assert.rejects(setupMittrServer({
    dataDir,
    logger: recordingLogger(),
    env: { ...rest, MITTR_AD_CLIENT_SECRET_FILE: path.join(home, 'missing-secret') },
    homeDir: home,
    context: { app: express(), express, dataDir, logger: recordingLogger(), host: null, requestScope: () => 'local', uiAuth, ...fakeEngineContext({ port: null }).context },
  }), /^Error: MITTR_AD_CLIENT_SECRET_FILE names a file that could not be read \(ENOENT\)/);
});

test('setup hands Mittr the folder the engine reads its user config from', async (t) => {
  const home = tempHome(t);
  const dataDir = prodLayout(home);
  const engineFile = path.join(home, '.config', 'mittrcraft', 'engine', 'opencode', 'opencode.json');
  const run = async (userConfigPath) => {
    const engine = fakeEngineContext({ port: null, userConfigFile: { model: 'mittr/a1' } });
    engine.engine.userConfig.path = userConfigPath;
    const logger = recordingLogger();
    const plugin = await setupMittrServer({
      dataDir,
      logger,
      env: { MITTRCRAFT_BROKER_URL: 'https://api.mittr.asia', MITTRCRAFT_BROKER_FIXED: '1', MITTRCRAFT_DEEP_LINK_SCHEME: 'mittrcraft' },
      homeDir: home,
      context: { app: express(), express, dataDir, logger, host: null, ...engine.context },
    });
    await plugin.dispose();
    return { engine, logger };
  };

  // Nobody is signed in, so a Mittr default is taken out of the engine's file.
  assert.deepEqual((await run(engineFile)).engine.userConfigFile, {});

  const personal = await run(path.join(home, '.config', 'opencode', 'opencode.json'));
  assert.deepEqual(personal.engine.userConfigWrites, []);
  assert.ok(personal.logger.lines.some((line) => line.includes('the default model is left alone')));
});

const homeOf = (userId) => crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16);

const mittrPlugin = async (t, { legacySession = null } = {}) => {
  const home = tempHome(t);
  const dataDir = prodLayout(home);
  if (legacySession !== null) writeFile(path.join(dataDir, 'mittr-session'), legacySession);
  const sessionOf = (userId, displayName) => ({ accessToken: `at-${userId}`, refreshToken: `r-${userId}`, expiresAt: Date.now() + 3_600_000, subject: { userId, displayName } });
  const handedOut = [sessionOf('u-a', 'A'), sessionOf('u-b', 'B')];
  const brokerCalls = [];
  const broker = await listen(t, (req, res) => {
    brokerCalls.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/auth/desktop/exchange') return res.end(JSON.stringify(handedOut.shift()));
    return res.end(JSON.stringify({ bundleVersion: 1, subject: null, models: [] }));
  });
  const engine = fakeEngineContext({ port: null });
  const app = express();
  const parseJson = express.json();
  app.use((req, res, next) => (req.path.startsWith('/api') ? next() : parseJson(req, res, next)));
  const logger = recordingLogger();
  const keys = [];
  const plugin = await setupMittrServer({
    dataDir,
    logger,
    env: { MITTRCRAFT_BROKER_URL: broker, MITTRCRAFT_DEEP_LINK_SCHEME: 'mittrcraft' },
    homeDir: home,
    context: { app, express, dataDir, logger, host: null, ...engine.context },
    mintShimKey: () => {
      keys.push(mintLocalToken());
      return keys.at(-1);
    },
  });
  t.after(() => plugin.dispose());
  const launch = async () => { engine.launchedDataHome = (await plugin.engineEnv()).XDG_DATA_HOME; };
  engine.onRestart = launch;
  await launch();
  const call = await serve(t, app);
  const signIn = async () => {
    await call('POST', '/api/mittr/auth/start');
    return call('POST', '/api/mittr/auth/callback', { url: 'mittrcraft://auth/callback?code=c1' });
  };
  const shared = path.join(home, '.local', 'share', 'mittrcraft', 'engine');
  assert.equal(keys.length, 1);
  assert.equal(fs.existsSync(path.join(dataDir, 'mittr-shim-token')), false);
  return { plugin, engine, call, signIn, shared, dataDir, brokerCalls, logger, shimKey: keys[0] };
};

test('each Mittr account runs the engine on its own home, and a switch restarts it there', async (t) => {
  const { plugin, engine, call, signIn, shared } = await mittrPlugin(t);
  const dataHome = async () => (await plugin.engineEnv()).XDG_DATA_HOME;
  const none = path.join(shared, 'accounts', '_none');

  assert.equal(await dataHome(), none);
  assert.equal(engine.launchedDataHome, none);

  assert.equal((await signIn()).body.userId, 'u-a');
  assert.deepEqual(engine.restarts, ['mittr account switched']);
  assert.equal(await dataHome(), path.join(shared, 'accounts', homeOf('u-a')));

  assert.equal((await signIn()).body.userId, 'u-b');
  assert.equal(engine.restarts.length, 2);
  assert.equal(await dataHome(), path.join(shared, 'accounts', homeOf('u-b')));

  assert.equal((await call('POST', '/api/mittr/auth/accounts/activate', { userId: 'u-a' })).body.userId, 'u-a');
  assert.equal(engine.restarts.length, 3);
  assert.equal(await dataHome(), path.join(shared, 'accounts', homeOf('u-a')));

  assert.equal((await call('DELETE', '/api/mittr/auth/session')).body.userId, 'u-b');
  assert.equal(engine.restarts.length, 4);
  assert.equal(await dataHome(), path.join(shared, 'accounts', homeOf('u-b')));

  assert.deepEqual((await call('DELETE', '/api/mittr/auth/session')).body, { signedIn: false });
  assert.equal(engine.restarts.length, 5);
  assert.equal(await dataHome(), none);
  assert.equal(engine.launchedDataHome, none);
});

test('a ready on another account\'s home is corrected after the listener returns, never inside it', async (t) => {
  const { engine, signIn, shared } = await mittrPlugin(t);
  assert.equal((await signIn()).body.userId, 'u-a');
  assert.equal(engine.restarts.length, 1);

  engine.launchedDataHome = path.join(shared, 'accounts', homeOf('u-b'));
  engine.fireReady();
  assert.equal(engine.restarts.length, 1);

  await until(() => engine.restarts.length === 2);
  assert.equal(engine.launchedDataHome, path.join(shared, 'accounts', homeOf('u-a')));
  engine.fireReady();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(engine.restarts.length, 2);
});

test('while the engine runs on another account\'s home the shim refuses, and forwards nothing', async (t) => {
  const { engine, call, signIn, shared, brokerCalls, shimKey: key } = await mittrPlugin(t);
  assert.equal((await signIn()).body.userId, 'u-a');
  engine.onRestart = null;
  engine.launchedDataHome = path.join(shared, 'accounts', homeOf('u-b'));

  const response = await fetch(`${call.base}/mittr-shim/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'a1', messages: [] }),
  });

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-should-retry'), 'false');
  assert.deepEqual(await response.json(), { error: { type: 'mittr_unavailable', code: 'switching_account', message: 'The Mittr account is changing. Send the message again in a moment.' } });
  assert.equal(brokerCalls.some((url) => url.includes('/chat/completions')), false);
});

test('a 1.x session that cannot be carried moves the engine off the shared home onto the empty one', async (t) => {
  const { engine, call, shared } = await mittrPlugin(t, { legacySession: 'not a session' });
  assert.equal(engine.launchedDataHome, shared);

  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: false });

  await until(() => engine.launchedDataHome === path.join(shared, 'accounts', '_none'));
  assert.deepEqual(engine.restarts, ['mittr account switched']);
});

test('while the engine is still on the shared home after a failed 1.x carry, the shim says nobody is signed in', async (t) => {
  const { engine, call, shared, brokerCalls, shimKey: key } = await mittrPlugin(t, { legacySession: 'not a session' });
  engine.onRestart = null;
  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: false });
  await until(() => engine.restarts.length === 2);
  assert.equal(engine.launchedDataHome, shared);

  const response = await fetch(`${call.base}/mittr-shim/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'a1', messages: [] }),
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: { type: 'mittr_unavailable', code: 'not_signed_in', message: 'Not signed in to Mittr. Sign in to continue.' } });
  assert.equal(brokerCalls.some((url) => url.includes('/chat/completions')), false);
});

test('the default export is the server-plugin setup', () => {
  assert.ok(setup instanceof Function);
});

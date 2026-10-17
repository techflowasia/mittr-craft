import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { fakeEngineContext, listen, serve, until } from './mittr/test-helpers.js';
import setup, { setupMittrServer } from './plugin.js';

const ACCOUNT = '0123456789abcdef';

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

const mittrPlugin = async (t) => {
  const home = tempHome(t);
  const dataDir = prodLayout(home);
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
  const logger = recordingLogger();
  const plugin = await setupMittrServer({
    dataDir,
    logger,
    env: { MITTRCRAFT_BROKER_URL: broker, MITTRCRAFT_DEEP_LINK_SCHEME: 'mittrcraft' },
    homeDir: home,
    context: { app, express, dataDir, logger, host: null, ...engine.context },
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
  return { plugin, engine, call, signIn, shared, dataDir, brokerCalls, logger };
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
  const { engine, call, signIn, shared, dataDir, brokerCalls } = await mittrPlugin(t);
  assert.equal((await signIn()).body.userId, 'u-a');
  engine.onRestart = null;
  engine.launchedDataHome = path.join(shared, 'accounts', homeOf('u-b'));
  const key = fs.readFileSync(path.join(dataDir, 'mittr-shim-token'), 'utf8').trim();

  const response = await fetch(`${call.base}/mittr-shim/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'a1', messages: [] }),
  });

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-should-retry'), 'false');
  assert.deepEqual(await response.json(), { error: 'The Mittr account is changing. Send the message again in a moment.' });
  assert.equal(brokerCalls.some((url) => url.includes('/chat/completions')), false);
});

test('the default export is the server-plugin setup', () => {
  assert.ok(setup instanceof Function);
});

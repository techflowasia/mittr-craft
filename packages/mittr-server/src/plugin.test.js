import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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
  return { lines, log: (...args) => lines.push(args.join(' ')), warn: (...args) => lines.push(args.join(' ')) };
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
    XDG_DATA_HOME: path.join(home, '.local', 'share', 'mittrcraft', 'engine'),
    XDG_STATE_HOME: path.join(home, '.local', 'state', 'mittrcraft', 'engine'),
    XDG_CACHE_HOME: path.join(home, '.cache', 'mittrcraft', 'engine'),
    OPENCODE_DB: 'opencode.db',
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

test('setup on the Dev layout backs up the data dir and moves the saved prod port', async (t) => {
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
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).desktopLocalPort, 57133);
  const env = await plugin.engineEnv();
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
    assert.equal(env[key], engineHome, key);
  }
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

test('the default export is the server-plugin setup', () => {
  assert.ok(setup instanceof Function);
});

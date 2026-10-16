import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ENGINE_DB_RULE, engineBases, engineEnv, sharedHistoryExists } from './engine-home.js';

const HOME = '/Users/someone';
const ACCOUNT = '0123456789abcdef';

const PROD_BASES = {
  config: '/Users/someone/.config/mittrcraft/engine',
  data: '/Users/someone/.local/share/mittrcraft/engine',
  state: '/Users/someone/.local/state/mittrcraft/engine',
  cache: '/Users/someone/.cache/mittrcraft/engine',
};

test('engineBases matches 1.22 home.js for prod', () => {
  assert.deepEqual(engineBases({ homeDir: HOME, env: {} }), PROD_BASES);
  assert.deepEqual(engineBases({ homeDir: HOME, env: { MITTRCRAFT_ENGINE_HOME: '   ' } }), PROD_BASES);
  assert.deepEqual(engineBases({ homeDir: HOME, env: { MITTRCRAFT_ENGINE_HOME: '' } }), PROD_BASES);
});

test('engineBases matches 1.22 home.js for MITTRCRAFT_ENGINE_HOME', () => {
  const root = '/Users/someone/.config/mittrcraft-dev/engine';
  assert.deepEqual(engineBases({ homeDir: HOME, env: { MITTRCRAFT_ENGINE_HOME: ` ${root} ` } }), {
    config: root,
    data: root,
    state: root,
    cache: root,
  });
});

test('engineBases ignores XDG variables the way 1.22 did', () => {
  assert.deepEqual(
    engineBases({ homeDir: HOME, env: { XDG_DATA_HOME: '/elsewhere', XDG_CONFIG_HOME: '/elsewhere' } }),
    PROD_BASES,
  );
});

test('engineEnv without an account uses the shared bases and pins the database file', () => {
  assert.deepEqual(engineEnv({ bases: PROD_BASES, accountHome: null, rule: ENGINE_DB_RULE }), {
    XDG_CONFIG_HOME: PROD_BASES.config,
    XDG_DATA_HOME: PROD_BASES.data,
    XDG_STATE_HOME: PROD_BASES.state,
    XDG_CACHE_HOME: PROD_BASES.cache,
    OPENCODE_DB: 'opencode.db',
  });
});

test('engineEnv puts data and state under accounts/<home>', () => {
  assert.deepEqual(engineEnv({ bases: PROD_BASES, accountHome: ACCOUNT, rule: ENGINE_DB_RULE }), {
    XDG_CONFIG_HOME: PROD_BASES.config,
    XDG_DATA_HOME: `${PROD_BASES.data}/accounts/${ACCOUNT}`,
    XDG_STATE_HOME: `${PROD_BASES.state}/accounts/${ACCOUNT}`,
    XDG_CACHE_HOME: PROD_BASES.cache,
    OPENCODE_DB: 'opencode.db',
  });
});

test('engineEnv leaves OPENCODE_DB out when the rule names no database', () => {
  const env = engineEnv({ bases: PROD_BASES, accountHome: null, rule: {} });
  assert.equal(Object.hasOwn(env, 'OPENCODE_DB'), false);
});

test('engineEnv refuses an account home that is not an account key', () => {
  for (const home of ['../../escape', 'ABCDEF0123456789', '0123456789abcde', '']) {
    assert.throws(() => engineEnv({ bases: PROD_BASES, accountHome: home, rule: ENGINE_DB_RULE }));
  }
});

test('engine env wins over a shell XDG_DATA_HOME', () => {
  const shellEnv = { XDG_DATA_HOME: '/Users/someone/.local/share', OPENCODE_DB: 'personal.db' };
  const processEnv = { XDG_DATA_HOME: '/Users/someone/.xdg', XDG_STATE_HOME: '/Users/someone/.state' };
  // The managed OpenCode's environment, in the order upstream's lifecycle merges it.
  const merged = {
    ...shellEnv,
    ...processEnv,
    ...engineEnv({ bases: PROD_BASES, accountHome: null, rule: ENGINE_DB_RULE }),
  };
  assert.equal(merged.XDG_DATA_HOME, PROD_BASES.data);
  assert.equal(merged.XDG_STATE_HOME, PROD_BASES.state);
  assert.equal(merged.OPENCODE_DB, 'opencode.db');
});

// A login shell's variables fill only what is still unset (main.mjs), after
// the product env is applied, so the prod product sets the root to blank: a
// MITTRCRAFT_ENGINE_HOME from the person's shell or the launching process can
// then never move prod's engine folders or what the backup copies.
test('the prod product neutralises a MITTRCRAFT_ENGINE_HOME from the shell or the launching process', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { applyProductEnv, readProduct } = await import('../../electron/product.mjs');
  const brand = path.resolve(import.meta.dirname, '..', '..', '..', 'brand');
  const productFs = {
    ...fs,
    readFileSync: (file, ...rest) => (path.basename(file) === 'product.json'
      ? fs.readFileSync(path.join(brand, 'product.prod.json'), ...rest)
      : fs.readFileSync(file, ...rest)),
  };
  const product = readProduct({ appPath: '/Applications/MittrCraft.app/Contents/Resources/app.asar', fs: productFs, homeDir: HOME });
  assert.equal(product.env.MITTRCRAFT_ENGINE_HOME, '');

  const launched = { MITTRCRAFT_ENGINE_HOME: '/elsewhere' };
  applyProductEnv(product, launched);
  const shell = { MITTRCRAFT_ENGINE_HOME: '/from/the/shell' };
  for (const [key, value] of Object.entries(shell)) if (launched[key] === undefined) launched[key] = value;

  assert.equal(launched.MITTRCRAFT_ENGINE_HOME, '');
  assert.deepEqual(engineBases({ homeDir: HOME, env: launched }), PROD_BASES);
});

test('shared history exists only when the shared data base holds a session database', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bases = { config: root, data: path.join(root, 'data'), state: path.join(root, 'state'), cache: root };

  assert.equal(sharedHistoryExists(bases), false);
  fs.mkdirSync(path.join(bases.data, 'accounts', ACCOUNT, 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(bases.data, 'accounts', ACCOUNT, 'opencode', 'opencode.db'), '');
  fs.writeFileSync(path.join(bases.data, 'opencode-notes.txt'), '');
  assert.equal(sharedHistoryExists(bases), false, 'an account home or another file is not shared history');

  fs.mkdirSync(path.join(bases.data, 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(bases.data, 'opencode', 'opencode.db'), '');
  assert.equal(sharedHistoryExists(bases), true);

  fs.rmSync(path.join(bases.data, 'opencode', 'opencode.db'));
  fs.writeFileSync(path.join(bases.data, 'opencode-local.db'), '');
  assert.equal(sharedHistoryExists(bases), true);
});

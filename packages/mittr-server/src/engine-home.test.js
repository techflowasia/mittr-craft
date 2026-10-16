import assert from 'node:assert/strict';
import test from 'node:test';

import { ENGINE_DB_RULE, engineBases, engineEnv } from './engine-home.js';

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

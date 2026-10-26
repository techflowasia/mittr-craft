import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { activeAccountHome } from './accounts.js';
import { NO_ACCOUNT_HOME } from './engine-home.js';

const FIRST = { userId: 'user-first', displayName: 'First', home: null, signedIn: true };
const SECOND = { userId: 'user-second', displayName: 'Second', home: '0123456789abcdef', signedIn: true };

const withRawIndex = (t, raw) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-accounts-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  if (raw !== undefined) {
    fs.mkdirSync(path.join(dataDir, 'mittr-accounts'));
    fs.writeFileSync(path.join(dataDir, 'mittr-accounts', 'index.json'), raw);
  }
  return dataDir;
};

const withDataDir = (t, index) => withRawIndex(t, index === undefined ? undefined : JSON.stringify(index, null, 2));

const silent = { warn: () => {} };

test('activeAccountHome returns the active account home', (t) => {
  const dataDir = withDataDir(t, { active: SECOND.userId, accounts: [FIRST, SECOND] });
  assert.equal(activeAccountHome(dataDir, { logger: silent }), SECOND.home);
});

test('activeAccountHome is null for the first account, whose home is null', (t) => {
  const dataDir = withDataDir(t, { active: FIRST.userId, accounts: [FIRST, SECOND] });
  assert.equal(activeAccountHome(dataDir, { logger: silent }), null);
});

test('activeAccountHome is the empty home without an index file, and null while a 1.x session waits', (t) => {
  assert.equal(activeAccountHome(withDataDir(t), { logger: silent }), NO_ACCOUNT_HOME);

  const waiting = withDataDir(t);
  fs.writeFileSync(path.join(waiting, 'mittr-session'), 'sealed');
  assert.equal(activeAccountHome(waiting, { logger: silent }), null);

  const empty = withDataDir(t, { active: null, accounts: [] });
  fs.writeFileSync(path.join(empty, 'mittr-session'), 'sealed');
  assert.equal(activeAccountHome(empty, { logger: silent }), null);
});

test('activeAccountHome is the empty home when no account is active, even with a 1.x session left beside accounts', (t) => {
  const dataDir = withDataDir(t, { active: null, accounts: [FIRST, SECOND] });
  assert.equal(activeAccountHome(dataDir, { logger: silent }), NO_ACCOUNT_HOME);
  fs.writeFileSync(path.join(dataDir, 'mittr-session'), 'sealed');
  assert.equal(activeAccountHome(dataDir, { logger: silent }), NO_ACCOUNT_HOME);
});

test('activeAccountHome falls back on corrupt index', (t) => {
  const warnings = [];
  const dataDir = withRawIndex(t, '{"active": "user-second", "accounts": [');
  assert.equal(activeAccountHome(dataDir, { logger: { warn: (...args) => warnings.push(args) } }), NO_ACCOUNT_HOME);
  assert.equal(warnings.length, 1);

  for (const index of ['null', '[]', '{"active":"user-second"}', '{"active":"user-second","accounts":{}}']) {
    assert.equal(activeAccountHome(withRawIndex(t, index), { logger: silent }), NO_ACCOUNT_HOME, index);
  }
});

test('activeAccountHome ignores an active account that is signed out', (t) => {
  const dataDir = withDataDir(t, {
    active: SECOND.userId,
    accounts: [FIRST, { ...SECOND, signedIn: false }],
  });
  assert.equal(activeAccountHome(dataDir, { logger: silent }), NO_ACCOUNT_HOME);
});

test('activeAccountHome ignores a home that is not an account key', (t) => {
  for (const home of ['../../escape', '0123456789ABCDEF', 42]) {
    const dataDir = withDataDir(t, { active: SECOND.userId, accounts: [FIRST, { ...SECOND, home }] });
    assert.equal(activeAccountHome(dataDir, { logger: silent }), NO_ACCOUNT_HOME, String(home));
  }
});

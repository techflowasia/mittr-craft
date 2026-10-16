import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { activeAccountHome } from '../accounts.js';
import { createAccountStore } from './account-store.js';

// Stands in for the keychain. It has to obscure the bytes: a double that only
// prefixes the plaintext would let the no-plaintext test pass while proving
// nothing.
const encrypt = (text) => Buffer.from(Buffer.from(text, 'utf8').toString('base64'), 'utf8');
const decrypt = (buffer) => Buffer.from(Buffer.from(buffer).toString('utf8'), 'base64').toString('utf8');

const sessionFor = (userId, displayName, token = `at-${userId}`) => ({
  accessToken: token,
  refreshToken: `rt-${userId}`,
  expiresAt: 1_800_000,
  subject: { userId, displayName },
});

const tempDataDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-account-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const storeIn = (dataDir) => () => createAccountStore({ dataDir, encrypt, decrypt });
const homeOf = (userId) => crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16);
const accountsDir = (dataDir) => path.join(dataDir, 'mittr-accounts');

test('no account and no session before anyone signs in', (t) => {
  const store = storeIn(tempDataDir(t));
  assert.equal(store().read(), null);
  assert.deepEqual(store().list(), []);
  assert.equal(store().activeHome(), null);
});

test('a second account sits beside the first and the newest one is active', (t) => {
  const store = storeIn(tempDataDir(t));
  store().write(sessionFor('u1', 'A'));
  store().write(sessionFor('u2', 'B'));
  assert.equal(store().read().subject.userId, 'u2');
  assert.deepEqual(store().list(), [
    { userId: 'u1', displayName: 'A', active: false },
    { userId: 'u2', displayName: 'B', active: true },
  ]);
});

test('writing without activating keeps the active account', (t) => {
  const store = storeIn(tempDataDir(t));
  store().write(sessionFor('u1', 'A'));
  store().write(sessionFor('u2', 'B'));
  store().write(sessionFor('u1', 'A', 'at-rotated'), { activate: false });
  assert.equal(store().read().subject.userId, 'u2');
  store().activate('u1');
  assert.equal(store().read().accessToken, 'at-rotated');
});

test('switching between signed-in accounts signs neither out, and an unknown account is refused', (t) => {
  const store = storeIn(tempDataDir(t));
  store().write(sessionFor('u1', 'A'));
  store().write(sessionFor('u2', 'B'));
  store().activate('u1');
  assert.equal(store().read().accessToken, 'at-u1');
  assert.deepEqual(store().list().map((account) => account.userId), ['u1', 'u2']);
  assert.throws(() => store().activate('nobody'), /not signed in/);
  assert.equal(store().read().subject.userId, 'u1');
});

test('signing in again as a known account updates it instead of adding a copy', (t) => {
  const store = storeIn(tempDataDir(t));
  store().write(sessionFor('u1', 'A'));
  store().write(sessionFor('u1', 'A Tan', 'at-new'));
  assert.deepEqual(store().list(), [{ userId: 'u1', displayName: 'A Tan', active: true }]);
  assert.equal(store().read().accessToken, 'at-new');
});

test('the first account keeps the shared history and each later one gets its own home', (t) => {
  const store = storeIn(tempDataDir(t));
  store().write(sessionFor('u1', 'A'));
  assert.equal(store().activeHome(), null);
  store().write(sessionFor('u2', 'B'));
  assert.equal(store().activeHome(), homeOf('u2'));
  store().activate('u1');
  assert.equal(store().activeHome(), null);
});

test('signing out the active account moves to the one left and keeps its home for later', (t) => {
  const dataDir = tempDataDir(t);
  const store = storeIn(dataDir);
  store().write(sessionFor('u1', 'A'));
  store().write(sessionFor('u2', 'B'));
  store().clear();
  assert.equal(store().read().subject.userId, 'u1');
  assert.deepEqual(store().list(), [{ userId: 'u1', displayName: 'A', active: true }]);
  assert.equal(fs.existsSync(path.join(accountsDir(dataDir), `${homeOf('u2')}.session`)), false);
  store().write(sessionFor('u2', 'B'));
  assert.equal(store().activeHome(), homeOf('u2'));
});

test('signing out an inactive account leaves the active one alone', (t) => {
  const store = storeIn(tempDataDir(t));
  store().write(sessionFor('u1', 'A'));
  store().write(sessionFor('u2', 'B'));
  store().signOut('u1');
  assert.deepEqual(store().list(), [{ userId: 'u2', displayName: 'B', active: true }]);
});

test('signed out entirely once the last account leaves', (t) => {
  const store = storeIn(tempDataDir(t));
  store().write(sessionFor('u1', 'A'));
  store().clear();
  assert.equal(store().read(), null);
  assert.deepEqual(store().list(), []);
});

test('the single session 1.x stored becomes the first account, once', (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(path.join(dataDir, 'mittr-session'), encrypt(JSON.stringify(sessionFor('u1', 'A'))));
  const store = storeIn(dataDir);
  assert.equal(store().read().subject.userId, 'u1');
  assert.equal(store().activeHome(), null);
  assert.equal(fs.existsSync(path.join(dataDir, 'mittr-session')), false);
});

test('a 1.x session that cannot be decrypted is left where it is', (t) => {
  const dataDir = tempDataDir(t);
  const legacy = path.join(dataDir, 'mittr-session');
  fs.writeFileSync(legacy, encrypt(JSON.stringify(sessionFor('u1', 'A'))));
  const refuse = () => { throw new Error('no keychain'); };
  const store = createAccountStore({ dataDir, encrypt: refuse, decrypt: refuse });
  assert.equal(store.read(), null);
  assert.equal(fs.existsSync(legacy), true);
});

test('tokens are sealed and the files are private', (t) => {
  const dataDir = tempDataDir(t);
  storeIn(dataDir)().write(sessionFor('u1', 'A'));
  for (const name of fs.readdirSync(accountsDir(dataDir))) {
    const file = path.join(accountsDir(dataDir), name);
    assert.equal(fs.readFileSync(file).toString('utf8').includes('at-u1'), false, name);
    assert.equal(fs.readFileSync(file).toString('utf8').includes('rt-u1'), false, name);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, name);
  }
  assert.deepEqual(fs.readdirSync(accountsDir(dataDir)).sort(), [`${homeOf('u1')}.session`, 'index.json']);
});

test('an unreadable index reads as no accounts rather than crashing', (t) => {
  const dataDir = tempDataDir(t);
  fs.mkdirSync(accountsDir(dataDir), { recursive: true });
  fs.writeFileSync(path.join(accountsDir(dataDir), 'index.json'), 'garbage');
  const store = storeIn(dataDir);
  assert.equal(store().read(), null);
  assert.deepEqual(store().list(), []);
});

test('an index 1.x wrote is read unchanged', (t) => {
  const dataDir = tempDataDir(t);
  fs.mkdirSync(accountsDir(dataDir), { recursive: true });
  const index = {
    active: 'u2',
    accounts: [
      { userId: 'u1', displayName: 'A', home: null, signedIn: true },
      { userId: 'u2', displayName: 'B', home: homeOf('u2'), signedIn: true },
    ],
  };
  fs.writeFileSync(path.join(accountsDir(dataDir), 'index.json'), JSON.stringify(index, null, 2));
  fs.writeFileSync(path.join(accountsDir(dataDir), `${homeOf('u2')}.session`), encrypt(JSON.stringify(sessionFor('u2', 'B'))));
  const store = storeIn(dataDir)();
  assert.equal(store.read().accessToken, 'at-u2');
  assert.equal(store.activeHome(), homeOf('u2'));
  store.activate('u1');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(accountsDir(dataDir), 'index.json'), 'utf8')), { ...index, active: 'u1' });
});

test('phase-1 accounts reader agrees with the store', (t) => {
  const dataDir = tempDataDir(t);
  const store = storeIn(dataDir);
  store().write(sessionFor('u1', 'A'));
  store().write(sessionFor('u2', 'B'));
  assert.equal(activeAccountHome(dataDir, { logger: { warn: () => {} } }), homeOf('u2'));
  assert.equal(activeAccountHome(dataDir, { logger: { warn: () => {} } }), store().activeHome());
  store().activate('u1');
  assert.equal(activeAccountHome(dataDir, { logger: { warn: () => {} } }), null);
  store().signOut('u1');
  assert.equal(activeAccountHome(dataDir, { logger: { warn: () => {} } }), store().activeHome());
});

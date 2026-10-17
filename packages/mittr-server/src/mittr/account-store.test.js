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

// A machine with no shared engine history yet, as on a fresh install.
const storeIn = (dataDir, options = {}) => () => createAccountStore({ dataDir, encrypt, decrypt, sharedHistoryExists: () => false, ...options });
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

test('the 1.x session is opened on the first read, not when the store is created, and takes the shared history', (t) => {
  const dataDir = tempDataDir(t);
  const legacy = path.join(dataDir, 'mittr-session');
  fs.writeFileSync(legacy, encrypt(JSON.stringify(sessionFor('u1', 'A'))));
  let opened = 0;
  const counting = (data) => {
    opened += 1;
    return decrypt(data);
  };
  const store = createAccountStore({ dataDir, encrypt, decrypt: counting, sharedHistoryExists: () => true });
  assert.equal(opened, 0);
  assert.deepEqual(store.list({ carryLegacy: false }), []);
  assert.equal(store.activeHome({ carryLegacy: false }), null);
  assert.equal(opened, 0);
  assert.equal(fs.existsSync(legacy), true);

  assert.equal(store.read().subject.userId, 'u1');
  assert.equal(store.activeHome(), null);
  assert.deepEqual(store.list(), [{ userId: 'u1', displayName: 'A', active: true }]);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(accountsDir(dataDir), 'index.json'), 'utf8')).accounts[0].home, null);
});

test('the 1.x session is carried by the first write too, so a newcomer never takes its shared history', (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(path.join(dataDir, 'mittr-session'), encrypt(JSON.stringify(sessionFor('u1', 'A'))));
  const store = storeIn(dataDir, { sharedHistoryExists: () => true });
  store().write(sessionFor('u2', 'B'));
  assert.equal(store().readOf('u1').subject.userId, 'u1');
  assert.equal(store().activeHome(), homeOf('u2'));
  store().activate('u1');
  assert.equal(store().activeHome(), null);
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

test('readOf answers only a signed-in account', (t) => {
  const store = storeIn(tempDataDir(t));
  store().write(sessionFor('u1', 'A'));
  store().write(sessionFor('u2', 'B'));
  assert.equal(store().readOf('u1').accessToken, 'at-u1');
  store().signOut('u1');
  assert.equal(store().readOf('u1'), null);
  assert.equal(store().readOf('nobody'), null);
});

test('an index that exists but cannot be parsed is never overwritten', (t) => {
  const dataDir = tempDataDir(t);
  fs.mkdirSync(accountsDir(dataDir), { recursive: true });
  const indexFile = path.join(accountsDir(dataDir), 'index.json');
  const truncated = '{"active": "u1", "accounts": [{"userId": "u1", "home": null, "signedIn": tr';
  fs.writeFileSync(indexFile, truncated);
  fs.writeFileSync(path.join(dataDir, 'mittr-session'), encrypt(JSON.stringify(sessionFor('u2', 'B'))));
  const errors = [];
  const store = createAccountStore({ dataDir, encrypt, decrypt, logger: { error: (...args) => errors.push(args.join(' ')), warn: () => {} } });

  assert.throws(() => store.write(sessionFor('u2', 'B')), /account index cannot be read/);
  assert.throws(() => store.activate('u1'), /account index cannot be read/);
  assert.throws(() => store.signOut('u1'), /account index cannot be read/);
  assert.throws(() => store.clear(), /account index cannot be read/);

  assert.equal(fs.readFileSync(indexFile, 'utf8'), truncated);
  assert.deepEqual(fs.readdirSync(accountsDir(dataDir)), ['index.json']);
  assert.equal(fs.existsSync(path.join(dataDir, 'mittr-session')), true);
  assert.ok(errors.length >= 4);
  assert.equal(store.read(), null);
  assert.deepEqual(store.list(), []);
});

test('writes go through a temporary file and leave none behind', (t) => {
  const dataDir = tempDataDir(t);
  const renames = [];
  const recordingFs = { ...fs, renameSync: (from, to) => { renames.push([path.basename(from), path.basename(to)]); fs.renameSync(from, to); } };
  createAccountStore({ dataDir, encrypt, decrypt, fs: recordingFs }).write(sessionFor('u1', 'A'));
  assert.deepEqual(renames.map(([, to]) => to), [`${homeOf('u1')}.session`, 'index.json']);
  for (const [from, to] of renames) assert.notEqual(from, to);
  assert.deepEqual(fs.readdirSync(accountsDir(dataDir)).sort(), [`${homeOf('u1')}.session`, 'index.json']);
});

const writeIndexFile = (dataDir, text) => {
  fs.mkdirSync(accountsDir(dataDir), { recursive: true });
  fs.writeFileSync(path.join(accountsDir(dataDir), 'index.json'), text);
};
const silentLogger = () => {
  const lines = [];
  const record = (...args) => lines.push(args.join(' '));
  return { lines, log: record, warn: record, error: record };
};

test('valid JSON of the wrong shape is damaged, never an empty index to write over', (t) => {
  const shapes = [
    'null',
    '[]',
    '{}',
    '{"active": null, "accounts": {}}',
    '{"active": "u1", "accounts": [{"userId": "u1", "displayName": "A", "home": "../escape", "signedIn": true}]}',
    '{"active": "u1", "accounts": [{"displayName": "A", "home": null, "signedIn": true}]}',
    '{"active": 7, "accounts": []}',
  ];
  for (const shape of shapes) {
    const dataDir = tempDataDir(t);
    writeIndexFile(dataDir, shape);
    const store = createAccountStore({ dataDir, encrypt, decrypt, logger: silentLogger() });
    assert.equal(store.damaged(), true, shape);
    assert.throws(() => store.write(sessionFor('u2', 'B')), /account index cannot be read/, shape);
    assert.equal(fs.readFileSync(path.join(accountsDir(dataDir), 'index.json'), 'utf8'), shape);
  }
});

test('a missing or well-formed index is not damaged', (t) => {
  const dataDir = tempDataDir(t);
  const store = storeIn(dataDir);
  assert.equal(store().damaged(), false);
  store().write(sessionFor('u1', 'A'));
  assert.equal(store().damaged(), false);
});

test('repair sets the damaged index aside, deletes nothing and rebuilds the accounts it can prove, each on its own home', (t) => {
  const dataDir = tempDataDir(t);
  const store = storeIn(dataDir);
  store().write(sessionFor('u1', 'A'));
  store().write(sessionFor('u2', 'B'));
  store().write(sessionFor('u3', 'C'));
  const damagedText = '{"active": "u2", "accou';
  writeIndexFile(dataDir, damagedText);
  const logger = silentLogger();
  const repaired = createAccountStore({
    dataDir,
    encrypt,
    decrypt,
    logger,
    now: () => Date.UTC(2026, 9, 17, 8, 30, 0),
    sharedHistoryExists: () => true,
  });

  assert.deepEqual(repaired.repair(), { repaired: true });

  const setAside = path.join(accountsDir(dataDir), 'index.json.unreadable-2026-10-17T08-30-00-000Z');
  assert.equal(fs.readFileSync(setAside, 'utf8'), damagedText);
  assert.equal(repaired.damaged(), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(accountsDir(dataDir), 'index.json'), 'utf8')), {
    active: null,
    accounts: [
      { userId: 'u1', displayName: 'A', home: homeOf('u1'), signedIn: true },
      { userId: 'u2', displayName: 'B', home: homeOf('u2'), signedIn: true },
      { userId: 'u3', displayName: 'C', home: homeOf('u3'), signedIn: true },
    ],
  });
  assert.ok(logger.lines.some((line) => line.includes(setAside)), 'the set-aside path is logged');
  assert.deepEqual(repaired.repair(), { repaired: false });
});

test('repair skips a session it cannot open or whose name does not match its account', (t) => {
  const dataDir = tempDataDir(t);
  storeIn(dataDir)().write(sessionFor('u1', 'A'));
  fs.writeFileSync(path.join(accountsDir(dataDir), `${homeOf('u9')}.session`), encrypt(JSON.stringify(sessionFor('u8', 'H'))));
  fs.writeFileSync(path.join(accountsDir(dataDir), `${homeOf('u7')}.session`), 'not sealed');
  writeIndexFile(dataDir, 'not json');
  const repaired = createAccountStore({ dataDir, encrypt, decrypt, logger: silentLogger(), sharedHistoryExists: () => true });
  repaired.repair();
  assert.deepEqual(repaired.list(), [{ userId: 'u1', displayName: 'A', active: false }]);
  assert.equal(fs.existsSync(path.join(accountsDir(dataDir), `${homeOf('u9')}.session`)), true);
});

test('a repair whose write fails puts the damaged index back, so it can be tried again', (t) => {
  const dataDir = tempDataDir(t);
  storeIn(dataDir)().write(sessionFor('u1', 'A'));
  const damagedText = '{"active": "u1", "accou';
  writeIndexFile(dataDir, damagedText);
  const failingFs = {
    ...fs,
    writeFileSync: (file, ...rest) => {
      if (path.basename(String(file)).startsWith('index.json.')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return fs.writeFileSync(file, ...rest);
    },
  };
  const store = createAccountStore({ dataDir, encrypt, decrypt, fs: failingFs, logger: silentLogger(), sharedHistoryExists: () => true });

  assert.throws(() => store.repair(), /ENOSPC/);

  assert.equal(fs.readFileSync(path.join(accountsDir(dataDir), 'index.json'), 'utf8'), damagedText);
  assert.deepEqual(fs.readdirSync(accountsDir(dataDir)).filter((name) => name.startsWith('index.json')), ['index.json']);
  assert.equal(store.damaged(), true);
});

test('with shared engine history on disk, a new account on an empty index gets its own home', (t) => {
  const dataDir = tempDataDir(t);
  const store = storeIn(dataDir, { sharedHistoryExists: () => true });
  store().write(sessionFor('u1', 'A'));
  assert.equal(store().activeHome(), homeOf('u1'));
});

test('with no shared engine history yet, the first account gets the shared home', (t) => {
  const dataDir = tempDataDir(t);
  const store = storeIn(dataDir, { sharedHistoryExists: () => false });
  store().write(sessionFor('u1', 'A'));
  assert.equal(store().activeHome(), null);
  store().write(sessionFor('u2', 'B'));
  assert.equal(store().activeHome(), homeOf('u2'));
});

test('the 1.x single session keeps the shared history even when it exists', (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(path.join(dataDir, 'mittr-session'), encrypt(JSON.stringify(sessionFor('u1', 'A'))));
  const store = storeIn(dataDir, { sharedHistoryExists: () => true });
  assert.equal(store().read().subject.userId, 'u1');
  assert.equal(store().activeHome(), null);
});

test('a truncated index, repaired, then a new sign-in: the newcomer never gets the shared history', (t) => {
  const dataDir = tempDataDir(t);
  const options = { sharedHistoryExists: () => true, logger: silentLogger() };
  fs.writeFileSync(path.join(dataDir, 'mittr-session'), encrypt(JSON.stringify(sessionFor('u-z', 'Z'))));
  const store = storeIn(dataDir, options);
  assert.equal(store().activeHome(), null);
  fs.unlinkSync(path.join(accountsDir(dataDir), `${homeOf('u-z')}.session`));
  writeIndexFile(dataDir, '{"active": "u-z", "accounts": [{"userId": "u-z", "ho');

  assert.deepEqual(store().repair(), { repaired: true });
  store().write(sessionFor('u-y', 'Y'));

  assert.equal(store().read().subject.userId, 'u-y');
  assert.equal(store().activeHome(), homeOf('u-y'));
});

test('an index deleted outright does not hand the shared history to whoever signs in next', (t) => {
  const dataDir = tempDataDir(t);
  const store = storeIn(dataDir, { sharedHistoryExists: () => true });
  fs.writeFileSync(path.join(dataDir, 'mittr-session'), encrypt(JSON.stringify(sessionFor('u-z', 'Z'))));
  store().read();
  fs.rmSync(accountsDir(dataDir), { recursive: true });
  store().write(sessionFor('u-y', 'Y'));
  assert.equal(store().activeHome(), homeOf('u-y'));
});

test('residual case: the shared-history owner signed out, the one left is repaired onto its own home', (t) => {
  const dataDir = tempDataDir(t);
  const store = storeIn(dataDir, { sharedHistoryExists: () => true, logger: silentLogger() });
  fs.writeFileSync(path.join(dataDir, 'mittr-session'), encrypt(JSON.stringify(sessionFor('u1', 'A'))));
  store().write(sessionFor('u2', 'B'));
  store().signOut('u1');
  writeIndexFile(dataDir, 'not json');

  store().repair();

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(accountsDir(dataDir), 'index.json'), 'utf8')).accounts, [
    { userId: 'u2', displayName: 'B', home: homeOf('u2'), signedIn: true },
  ]);
});

test('stale temporary files from an interrupted write are swept when the store opens', (t) => {
  const dataDir = tempDataDir(t);
  storeIn(dataDir)().write(sessionFor('u1', 'A'));
  const stale = path.join(accountsDir(dataDir), 'index.json.4242-0a1b2c3d.tmp');
  const unrelated = path.join(accountsDir(dataDir), 'notes.tmp');
  fs.writeFileSync(stale, '{');
  fs.writeFileSync(unrelated, 'keep');
  storeIn(dataDir)();
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(unrelated), true);
});

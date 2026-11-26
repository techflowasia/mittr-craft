import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConsentStore } from './consent-store.js';

const owner = { accountID: 'synthetic-a', runtimeID: 'synthetic-runtime' };
const fixture = (t, options = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: createConsentStore({ root, ...options }) };
};
const claim = (store, scope = owner, sessionID = 'chat-a', expectedRevision = 0) => store.claimOffer(scope, { sessionID, turnID: 'turn-a', expectedRevision });
const answer = (store, decision, claimed, sessionID = 'chat-a') => store.answerOffer(owner, {
  sessionID, offerID: claimed.document.offer.id, decision, expectedRevision: claimed.document.revision,
});

test('missing consent is off without creating a file or accepting implicit storage roots', (t) => {
  const { root, store } = fixture(t);
  assert.deepEqual(store.read(owner), { status: 'ok', document: { version: 1, revision: 0, default: 'off', offer: { status: 'unseen' }, sessions: [] } });
  assert.deepEqual(fs.readdirSync(root), []);
  assert.throws(() => createConsentStore({}), /root/);
  assert.equal(store.read({ accountID: null, runtimeID: 'r' }).status, 'invalid');
  assert.equal(store.read({ accountID: '_none', runtimeID: 'r' }).status, 'invalid');
});

for (const [decision, defaultValue, sessions] of [['remember', 'on', []], ['chat', 'off', ['chat-a']], ['decline', 'off', []]]) {
  test(`${decision} commits the approved scope and never offers again after restart`, (t) => {
    const { root, store } = fixture(t);
    const claimed = claim(store);
    assert.equal(claimed.outcome, 'claimed');
    const result = answer(store, decision, claimed);
    assert.equal(result.status, 'ok');
    assert.equal(result.document.default, defaultValue);
    assert.deepEqual(result.document.sessions, sessions);
    assert.deepEqual(result.document.offer, { status: 'answered' });
    const restarted = createConsentStore({ root });
    assert.deepEqual(restarted.read(owner), { status: 'ok', document: result.document });
    assert.equal(claim(restarted, owner, 'next-chat', 2).outcome, 'answered');
  });
}

test('a claim is durable before return, restored only once across store instances and stale revisions conflict', (t) => {
  const { root, store } = fixture(t);
  const first = claim(store);
  const second = createConsentStore({ root });
  assert.deepEqual(second.read(owner).document.offer, first.document.offer);
  assert.equal(claim(second, owner, 'chat-b', 0).httpStatus, 409);
  const existing = claim(second, owner, 'chat-b', 1);
  assert.equal(existing.outcome, 'already-claimed');
  assert.equal(existing.document.offer.id, first.document.offer.id);
  assert.equal(answer(second, 'remember', first, 'chat-b').status, 'invalid');
  assert.equal(answer(second, 'chat', first).status, 'ok');
  assert.equal(answer(store, 'remember', first).httpStatus, 409);
});

test('two windows racing at one revision produce exactly one durable claim', async (t) => {
  const { root, store } = fixture(t);
  const other = createConsentStore({ root });
  const results = await Promise.all([Promise.resolve().then(() => claim(store)), Promise.resolve().then(() => claim(other, owner, 'chat-b'))]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['conflict', 'ok']);
  assert.equal(store.read(owner).document.revision, 1);
});

test('settings disable revokes chat grants; enable answers an unseen offer; deletion does not reset the offer', (t) => {
  const { store } = fixture(t);
  answer(store, 'chat', claim(store));
  assert.deepEqual(store.setDefault(owner, { enabled: false, expectedRevision: 2 }).document.sessions, []);
  assert.equal(store.setDefault(owner, { enabled: true, expectedRevision: 3 }).document.default, 'on');
  assert.equal(store.setDefault(owner, { enabled: false, expectedRevision: 4 }).document.default, 'off');
  const b = { ...owner, accountID: 'b' };
  assert.equal(store.setDefault(b, { enabled: true, expectedRevision: 0 }).document.offer.status, 'answered');
  const c = { ...owner, accountID: 'c' };
  const offered = claim(store, c);
  store.answerOffer(c, { decision: 'chat', sessionID: 'chat-a', offerID: offered.document.offer.id, expectedRevision: 1 });
  const deleted = store.deleteSession(c, { sessionID: 'chat-a', expectedRevision: 2 });
  assert.deepEqual(deleted.document.sessions, []);
  assert.equal(claim(store, c, 'new-chat', 3).outcome, 'answered');
});

test('accounts and runtimes with identical session IDs never share a decision', (t) => {
  const { store } = fixture(t);
  answer(store, 'remember', claim(store));
  for (const scope of [{ ...owner, accountID: 'b' }, { ...owner, runtimeID: 'another' }]) {
    assert.equal(store.read(scope).document.default, 'off');
    assert.equal(store.read(scope).document.offer.status, 'unseen');
  }
});

test('corrupt, unsupported, empty and invalid documents remain byte-for-byte intact and fail closed', (t) => {
  const { root, store } = fixture(t);
  claim(store);
  const file = path.join(root, ...fs.readdirSync(root).slice(0, 1));
  const accountDir = path.join(file, fs.readdirSync(file)[0]);
  const target = path.join(accountDir, 'consent.json');
  for (const text of ['', '{broken', JSON.stringify({ version: 9 }), JSON.stringify({ version: 1, revision: 2, default: 'on', offer: { status: 'unseen' }, sessions: [] })]) {
    fs.writeFileSync(target, text);
    assert.equal(store.read(owner).status, 'unavailable');
    assert.equal(store.setDefault(owner, { enabled: true, expectedRevision: 0 }).status, 'unavailable');
    assert.equal(fs.readFileSync(target, 'utf8'), text);
  }
});

test('failed atomic replacement preserves the old decision and cleans its private temporary file', (t) => {
  const { root, store } = fixture(t);
  const first = claim(store);
  const broken = createConsentStore({ root, fs: { ...fs, renameSync() { throw new Error('synthetic rename failure'); } } });
  assert.equal(answer(broken, 'remember', first).status, 'unavailable');
  assert.deepEqual(store.read(owner).document, first.document);
  const runtimeDir = path.join(root, fs.readdirSync(root)[0]);
  const accountDir = path.join(runtimeDir, fs.readdirSync(runtimeDir)[0]);
  assert.deepEqual(fs.readdirSync(accountDir), ['consent.json']);
  assert.equal(fs.statSync(path.join(accountDir, 'consent.json')).mode & 0o777, 0o600);
});

test('unreadable files and contended process locks are unavailable, never an unseen offer', (t) => {
  const { root, store } = fixture(t);
  claim(store);
  const broken = createConsentStore({ root, fs: { ...fs, readFileSync() { throw Object.assign(new Error('synthetic'), { code: 'EACCES' }); } } });
  assert.equal(broken.read(owner).status, 'unavailable');
  const runtimeDir = path.join(root, fs.readdirSync(root)[0]);
  const accountDir = path.join(runtimeDir, fs.readdirSync(runtimeDir)[0]);
  fs.mkdirSync(path.join(accountDir, 'consent.lock'));
  assert.equal(store.setDefault(owner, { enabled: true, expectedRevision: 1 }).status, 'unavailable');
  assert.equal(store.read(owner).document.default, 'off');
});

// Real filesystem operations with instrumentation only at the durability boundary.
const tracedFilesystem = (failSync) => {
  const descriptors = new Map();
  const events = [];
  return {
    events,
    fs: {
      ...fs,
      openSync(file, ...args) {
        const fd = fs.openSync(file, ...args);
        descriptors.set(fd, file);
        return fd;
      },
      closeSync(fd) {
        descriptors.delete(fd);
        return fs.closeSync(fd);
      },
      fsyncSync(fd) {
        const file = descriptors.get(fd);
        events.push(['sync', file]);
        if (failSync?.(file)) throw new Error('synthetic directory sync failure');
        return fs.fsyncSync(fd);
      },
      renameSync(from, to) {
        events.push(['rename', to]);
        return fs.renameSync(from, to);
      },
    },
  };
};
const namespace = (root) => {
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const runtimeDir = path.join(root, hash(owner.runtimeID));
  return { runtimeDir, accountDir: path.join(runtimeDir, hash(owner.accountID)) };
};

test('first claim syncs namespace parents from the stable root before the file commit', (t) => {
  const { root } = fixture(t);
  const { runtimeDir, accountDir } = namespace(root);
  const traced = tracedFilesystem();
  const result = claim(createConsentStore({ root, fs: traced.fs }));
  assert.equal(result.outcome, 'claimed');
  assert.deepEqual(traced.events.slice(0, 2), [['sync', root], ['sync', runtimeDir]]);
  assert.equal(path.dirname(traced.events[2][1]), accountDir);
  assert.deepEqual(traced.events.slice(3), [['rename', path.join(accountDir, 'consent.json')], ['sync', accountDir]]);
});

for (const parent of ['root', 'runtime']) {
  for (const action of ['claim', 'enable']) {
    test(`${parent} sync failure cannot acknowledge ${action}, and retry syncs existing namespace entries`, (t) => {
      const { root, store } = fixture(t);
      const { runtimeDir } = namespace(root);
      const failing = tracedFilesystem((file) => file === (parent === 'root' ? root : runtimeDir));
      const broken = createConsentStore({ root, fs: failing.fs });
      const result = action === 'claim' ? claim(broken) : broken.setDefault(owner, { enabled: true, expectedRevision: 0 });
      assert.deepEqual(result, { status: 'unavailable', httpStatus: 503 });
      assert.equal(failing.events.some(([event]) => event === 'rename'), false);
      assert.equal(store.read(owner).document.offer.status, 'unseen');
      assert.equal(store.read(owner).document.default, 'off');
      const retry = tracedFilesystem();
      assert.equal(claim(createConsentStore({ root, fs: retry.fs })).outcome, 'claimed');
      assert.deepEqual(retry.events.slice(0, 2), [['sync', root], ['sync', runtimeDir]]);
    });
  }
}

test('namespace sync failure preserves an existing answered decision byte-for-byte', (t) => {
  const { root, store } = fixture(t);
  const committed = answer(store, 'remember', claim(store));
  const { runtimeDir, accountDir } = namespace(root);
  const file = path.join(accountDir, 'consent.json');
  const before = fs.readFileSync(file, 'utf8');
  const failing = tracedFilesystem((target) => target === runtimeDir);
  const broken = createConsentStore({ root, fs: failing.fs });
  assert.deepEqual(broken.setDefault(owner, { enabled: false, expectedRevision: 2 }), { status: 'unavailable', httpStatus: 503 });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(store.read(owner).document, committed.document);
});

test('a missing injected root is unavailable and is never created by a mutation', (t) => {
  const { root } = fixture(t);
  const missing = path.join(root, 'not-provisioned');
  const store = createConsentStore({ root: missing });
  assert.deepEqual(claim(store), { status: 'unavailable', httpStatus: 503 });
  assert.equal(fs.existsSync(missing), false);
});

test('invalid mutation inputs never create consent or coerce a grant', (t) => {
  const { root, store } = fixture(t);
  for (const enabled of ['true', null, 1]) assert.equal(store.setDefault(owner, { enabled, expectedRevision: 0 }).status, 'invalid');
  assert.equal(claim(store, owner, '', 0).status, 'invalid');
  assert.equal(claim(store, owner, 'a', -1).status, 'invalid');
  assert.equal(store.setDefault(owner, { enabled: true, expectedRevision: 0, accountID: 'forged' }).status, 'invalid');
  assert.deepEqual(fs.readdirSync(root), []);
});

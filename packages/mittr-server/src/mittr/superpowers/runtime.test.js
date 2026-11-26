import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConsentStore } from './consent-store.js';
import { createSuperpowersRuntime } from './runtime.js';

const a = { accountID: 'a', runtimeID: 'r' };
const b = { accountID: 'b', runtimeID: 'r' };
const fixture = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createConsentStore({ root });
  let principal = { ...a, generation: 1 };
  let session = { sessionID: 's', kind: 'root' };
  const runtime = createSuperpowersRuntime({ store, resolveOwner: () => principal, resolveSession: async () => session });
  return { store, runtime, switchOwner(value) { principal = value; }, switchSession(value) { session = value; } };
};
const enable = (store, owner = a) => store.setDefault(owner, { enabled: true, expectedRevision: 0 });

test('grant starts disabled, remember enables future root chats, disable is read on every call', async (t) => {
  const { store, runtime, switchSession } = fixture(t);
  assert.equal((await runtime.effectiveGrant('s')).status, 'disabled');
  enable(store);
  assert.equal((await runtime.effectiveGrant('s')).status, 'enabled');
  switchSession({ sessionID: 'next', kind: 'root' });
  assert.equal((await runtime.effectiveGrant('next')).status, 'enabled');
  store.setDefault(a, { enabled: false, expectedRevision: 1 });
  assert.equal((await runtime.effectiveGrant('next')).status, 'disabled');
});

test('chat-only survives runtime reconstruction but does not copy to forks or other sessions', async (t) => {
  const { store, runtime, switchSession } = fixture(t);
  const offer = await runtime.claimOffer('s', { turnID: 'turn', expectedRevision: 0 });
  assert.equal((await runtime.answerOffer('s', { offerID: offer.document.offer.id, decision: 'chat', expectedRevision: 1 })).status, 'ok');
  assert.equal((await runtime.effectiveGrant('s')).status, 'enabled');
  const restarted = createSuperpowersRuntime({ store, resolveOwner: () => ({ ...a, generation: 2 }), resolveSession: async (_owner, sessionID) => ({ sessionID, kind: 'root' }) });
  assert.equal((await restarted.effectiveGrant('s')).status, 'enabled');
  switchSession({ sessionID: 'fork', kind: 'root' });
  assert.equal((await runtime.effectiveGrant('fork')).status, 'disabled');
  assert.equal((await runtime.claimOffer('fork', { turnID: 'next', expectedRevision: 2 })).outcome, 'answered');
});

test('no logged-out shared owner, missing sessions or unverified child inheritance even with default on', async (t) => {
  const { store, runtime, switchOwner, switchSession } = fixture(t);
  enable(store);
  switchSession({ sessionID: 's', kind: 'child', parentID: 's-parent' });
  assert.equal((await runtime.effectiveGrant('s')).status, 'disabled');
  assert.equal((await runtime.claimOffer('s', { turnID: 'turn', expectedRevision: 1 })).status, 'disabled');
  switchSession(null);
  assert.equal((await runtime.effectiveGrant('s')).status, 'disabled');
  switchOwner(null);
  assert.equal((await runtime.effectiveGrant('s')).status, 'disabled');
  assert.equal((await runtime.setDefault({ enabled: true, expectedRevision: 0 })).status, 'disabled');
});

test('account, runtime and trusted session identity isolate identical engine IDs', async (t) => {
  const { store, runtime, switchOwner, switchSession } = fixture(t);
  enable(store);
  switchOwner({ ...b, generation: 2 });
  assert.equal((await runtime.effectiveGrant('s')).status, 'disabled');
  switchOwner({ ...a, runtimeID: 'other', generation: 3 });
  assert.equal((await runtime.effectiveGrant('s')).status, 'disabled');
  switchOwner({ ...a, generation: 4 });
  switchSession({ sessionID: 'not-s', kind: 'root' });
  assert.equal((await runtime.effectiveGrant('s')).status, 'disabled');
  assert.equal((await runtime.answerOffer('s', { offerID: 'x', decision: 'remember', expectedRevision: 1 })).status, 'disabled');
});

test('A to B to A while a trusted session lookup is pending fences reads and decisions before commit', async (t) => {
  const { store } = fixture(t);
  enable(store);
  let principal = { ...a, generation: 1 };
  let release;
  const runtime = createSuperpowersRuntime({ store, resolveOwner: () => principal, resolveSession: () => new Promise((resolve) => { release = resolve; }) });
  const pending = runtime.effectiveGrant('s');
  principal = { ...b, generation: 2 };
  principal = { ...a, generation: 3 };
  release({ sessionID: 's', kind: 'root' });
  assert.equal((await pending).httpStatus, 409);
  const pendingClaim = runtime.claimOffer('s', { turnID: 'turn', expectedRevision: 1 });
  principal = { ...b, generation: 4 };
  release({ sessionID: 's', kind: 'root' });
  assert.equal((await pendingClaim).status, 'scope-changed');
  assert.equal(store.read(a).document.revision, 1);
});

test('unavailable authority fails closed and returns no enabled result', async (t) => {
  const { store } = fixture(t);
  const unavailableStore = { ...store, read: () => ({ status: 'unavailable', httpStatus: 503 }) };
  const runtime = createSuperpowersRuntime({ store: unavailableStore, resolveOwner: () => ({ ...a, generation: 1 }), resolveSession: async () => ({ sessionID: 's', kind: 'root' }) });
  assert.equal((await runtime.effectiveGrant('s')).status, 'unavailable');
  const failing = createSuperpowersRuntime({ store, resolveOwner: () => { throw new Error('synthetic'); }, resolveSession: async () => null });
  assert.equal((await failing.effectiveGrant('s')).status, 'unavailable');
});

test('runtime deletion revokes the exact session grant and settings disable cannot leave it active', async (t) => {
  const { runtime } = fixture(t);
  const claim = await runtime.claimOffer('s', { turnID: 'turn', expectedRevision: 0 });
  await runtime.answerOffer('s', { offerID: claim.document.offer.id, decision: 'chat', expectedRevision: 1 });
  assert.equal((await runtime.deleteSession('s', { expectedRevision: 2 })).status, 'ok');
  assert.equal((await runtime.effectiveGrant('s')).status, 'disabled');
  assert.equal((await runtime.setDefault({ enabled: true, expectedRevision: 3 })).status, 'ok');
  assert.equal((await runtime.setDefault({ enabled: false, expectedRevision: 4 })).status, 'ok');
  assert.equal((await runtime.effectiveGrant('s')).status, 'disabled');
});

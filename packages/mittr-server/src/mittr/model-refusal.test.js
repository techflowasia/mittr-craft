import assert from 'node:assert/strict';
import test from 'node:test';

import { createModelRefusalHandler, createThrottle, describeModelRefusal } from './model-refusal.js';

test('entitlement refusal is recognised from the platform\'s wire body', () => {
  const body = { error: { message: 'desktop_entitlement_required', type: 'invalid_request_error', code: 'forbidden' } };
  assert.deepEqual(describeModelRefusal(body), { reason: 'entitlement', canResync: false });
});

test('withdrawn agent asks for a re-sync', () => {
  assert.deepEqual(describeModelRefusal({ error: { code: 'agent_not_granted', message: 'agent_not_granted' } }), { reason: 'stale-catalog', canResync: true });
});

test('the code is read first, then the message, then a plain string error', () => {
  assert.equal(describeModelRefusal({ error: { code: 'agent_not_granted', message: 'desktop_entitlement_required' } }).reason, 'stale-catalog');
  assert.equal(describeModelRefusal({ error: { code: 'forbidden', message: 'agent_not_granted' } }).reason, 'stale-catalog');
  assert.equal(describeModelRefusal({ error: { message: 'desktop_entitlement_required' } }).reason, 'entitlement');
  assert.equal(describeModelRefusal({ error: 'agent_not_granted' }).reason, 'stale-catalog');
  assert.equal(describeModelRefusal({ error: 'desktop_entitlement_required' }).reason, 'entitlement');
});

test('anything else is unknown and cannot be repaired by a re-sync', () => {
  const unknown = { reason: 'unknown', canResync: false };
  for (const body of [null, undefined, 'agent_not_granted', 42, [], {}, { error: null }, { error: {} }, { error: 'something_else' }, { error: { code: 'forbidden', message: 'nope' } }, { error: { code: 7, message: {} } }]) {
    assert.deepEqual(describeModelRefusal(body), unknown, JSON.stringify(body));
  }
});

test('a refusal word inside a longer message is not a refusal', () => {
  assert.equal(describeModelRefusal({ error: { message: 'agent_not_granted_yet' } }).reason, 'unknown');
  assert.equal(describeModelRefusal({ error: { message: 'x desktop_entitlement_required' } }).reason, 'unknown');
});

test('a throttle lets one through per interval, measured from the last one let through', () => {
  let at = 1_000;
  const allow = createThrottle(60_000, () => at);
  assert.equal(allow(), true);
  at += 10_000;
  assert.equal(allow(), false);
  at += 49_999;
  assert.equal(allow(), false);
  at += 1;
  assert.equal(allow(), true);
  at += 59_999;
  assert.equal(allow(), false);
});

const catalogOf = (...aliases) => ({ configured: true, items: aliases.map((alias) => ({ alias, label: alias })) });

const refusalHandler = ({ before, after = before, allow = true } = {}) => {
  let models = before;
  const calls = { syncs: 0 };
  const handle = createModelRefusalHandler({
    mayResync: () => allow,
    syncStored: async () => {
      calls.syncs += 1;
      models = after;
      return { status: 200 };
    },
    catalogModels: () => models,
  });
  return { handle, calls };
};

test('an entitlement refusal for a model the sync then drops says the model was withdrawn', async () => {
  const { handle, calls } = refusalHandler({ before: catalogOf('mittr-fast', 'mittr-pro'), after: catalogOf('mittr-fast') });
  assert.deepEqual(await handle({ kind: 'model', reason: 'entitlement', model: 'mittr-pro' }), { withdrawn: true });
  assert.equal(calls.syncs, 1);
});

test('an entitlement refusal for a model still in the catalog stays an entitlement refusal', async () => {
  const { handle, calls } = refusalHandler({ before: catalogOf('mittr-fast', 'mittr-pro') });
  assert.equal(await handle({ kind: 'model', reason: 'entitlement', model: 'mittr-pro' }), undefined);
  assert.equal(calls.syncs, 1);
});

test('within the throttle no sync runs and the catalog already held decides', async () => {
  const gone = refusalHandler({ before: catalogOf('mittr-fast'), allow: false });
  assert.deepEqual(await gone.handle({ kind: 'model', reason: 'entitlement', model: 'mittr-pro' }), { withdrawn: true });
  assert.equal(gone.calls.syncs, 0);
  const kept = refusalHandler({ before: catalogOf('mittr-pro'), allow: false });
  assert.equal(await kept.handle({ kind: 'model', reason: 'entitlement', model: 'mittr-pro' }), undefined);
});

test('without a model or a usable catalog nothing is claimed', async () => {
  const { handle, calls } = refusalHandler({ before: catalogOf('mittr-fast') });
  assert.equal(await handle({ kind: 'model', reason: 'entitlement', model: null }), undefined);
  assert.equal(calls.syncs, 0);
  for (const models of [null, undefined, { configured: false, items: [] }]) {
    assert.equal(await refusalHandler({ before: models }).handle({ kind: 'model', reason: 'entitlement', model: 'mittr-pro' }), undefined);
  }
});

test('a withdrawn agent refusal starts a throttled sync and waits for nothing', async () => {
  let release;
  const syncs = [];
  const handle = createModelRefusalHandler({
    mayResync: () => syncs.length === 0,
    syncStored: () => {
      syncs.push(1);
      return new Promise((resolve) => { release = resolve; });
    },
    catalogModels: () => catalogOf('mittr-fast'),
  });
  assert.equal(await handle({ kind: 'model', reason: 'stale-catalog', model: 'mittr-pro' }), undefined);
  assert.equal(await handle({ kind: 'model', reason: 'stale-catalog', model: 'mittr-pro' }), undefined);
  assert.equal(syncs.length, 1);
  release({ status: 200 });
});

test('an unknown refusal neither syncs nor claims anything', async () => {
  const { handle, calls } = refusalHandler({ before: catalogOf('mittr-fast') });
  assert.equal(await handle({ kind: 'model', reason: 'unknown', model: 'mittr-pro' }), undefined);
  assert.equal(calls.syncs, 0);
});

test('a refusal while a sync is out waits for that sync instead of reading the catalog it replaces', async () => {
  let models = catalogOf('mittr-fast', 'mittr-pro');
  let release;
  let syncs = 0;
  const handle = createModelRefusalHandler({
    mayResync: () => syncs === 0,
    syncStored: () => {
      syncs += 1;
      return new Promise((resolve) => { release = resolve; });
    },
    catalogModels: () => models,
  });
  const first = handle({ kind: 'model', reason: 'entitlement', model: 'mittr-pro' });
  const second = handle({ kind: 'model', reason: 'entitlement', model: 'mittr-pro' });
  await new Promise((resolve) => { setImmediate(resolve); });
  models = catalogOf('mittr-fast');
  release();
  assert.deepEqual(await first, { withdrawn: true });
  assert.deepEqual(await second, { withdrawn: true });
  assert.equal(syncs, 1);
});

test('a sync that outlasts the wait is not waited for, and the catalog already held decides', async () => {
  const handle = createModelRefusalHandler({
    mayResync: () => true,
    syncStored: () => new Promise(() => {}),
    catalogModels: () => catalogOf('mittr-fast'),
    waitMs: 20,
  });
  const started = Date.now();
  assert.deepEqual(await handle({ kind: 'model', reason: 'entitlement', model: 'mittr-pro' }), { withdrawn: true });
  assert.ok(Date.now() - started < 1_000);
});

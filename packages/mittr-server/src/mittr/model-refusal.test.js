import assert from 'node:assert/strict';
import test from 'node:test';

import { createThrottle, describeModelRefusal } from './model-refusal.js';

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

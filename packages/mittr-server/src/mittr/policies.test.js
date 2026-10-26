import assert from 'node:assert/strict';
import test from 'node:test';

import { policiesFor, policiesFragment } from './policies.js';

const LOCKED = [
  { action: 'provider.use', resource: '*', effect: 'deny' },
  { action: 'provider.use', resource: 'mittr', effect: 'allow' },
];

test('policiesFor locks to one provider', () => {
  assert.deepEqual(policiesFor({ showOtherProviders: false, providerId: 'mittr' }), LOCKED);
  assert.deepEqual(policiesFor({ showOtherProviders: true, providerId: 'mittr' }), [
    { action: 'provider.use', resource: '*', effect: 'allow' },
  ]);
});

test('the switch off locks the engine to Mittr', () => {
  assert.deepEqual(policiesFragment({ showOtherProviders: false }), { experimental: { policies: LOCKED } });
});

test('the switch on allows every provider, the hosted opencode one included as in 1.22, and the fragment is never empty', () => {
  assert.deepEqual(policiesFragment({ showOtherProviders: true }), {
    experimental: { policies: [{ action: 'provider.use', resource: '*', effect: 'allow' }] },
  });
});

test('anything but an explicit true counts as the switch off', () => {
  for (const value of [undefined, null, 'true', 1, {}]) {
    assert.deepEqual(policiesFragment({ showOtherProviders: value }), { experimental: { policies: LOCKED } }, String(value));
  }
});

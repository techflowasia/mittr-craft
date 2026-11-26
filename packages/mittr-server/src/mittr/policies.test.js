import assert from 'node:assert/strict';
import test from 'node:test';

import { policiesFor, policiesFragment, syncUserConfigLock, userPolicies } from './policies.js';

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
  assert.deepEqual(policiesFragment({ showOtherProviders: false }), { policies: LOCKED });
});

test('the switch on allows every provider, the hosted opencode one included as in 1.22, and the fragment is never empty', () => {
  assert.deepEqual(policiesFragment({ showOtherProviders: true }), {
    policies: [{ action: 'provider.use', resource: '*', effect: 'allow' }],
  });
});

test('anything but an explicit true counts as the switch off', () => {
  for (const value of [undefined, null, 'true', 1, {}]) {
    assert.deepEqual(policiesFragment({ showOtherProviders: value }), { policies: LOCKED }, String(value));
  }
});

const ALLOW_ALL = { action: 'provider.use', resource: '*', effect: 'allow' };

const DENY_ALL = LOCKED[0];
const ALLOW_MITTR = LOCKED[1];
const OFF = { showOtherProviders: false };
const ON = { showOtherProviders: true };

test('locked, the lock goes after the person\'s own rules, and a lock from an earlier write is replaced, not repeated', () => {
  const own = [{ action: 'skill.use', resource: 'x', effect: 'deny' }, { action: 'provider.use', resource: 'openai', effect: 'allow' }];
  assert.deepEqual(userPolicies(undefined, OFF), LOCKED);
  assert.deepEqual(userPolicies('not a list', OFF), LOCKED);
  assert.deepEqual(userPolicies(own, OFF), [...own, ...LOCKED]);
  assert.deepEqual(userPolicies([...own, ALLOW_ALL], OFF), [...own, ...LOCKED]);
  assert.deepEqual(userPolicies([...LOCKED, ...own], OFF), [...own, ...LOCKED]);
  const marked = { ...ALLOW_ALL, note: 'mine' };
  assert.deepEqual(userPolicies([marked], OFF), [marked, ...LOCKED]);
});

test('rules another writer adds after the lock do not stack locks', () => {
  let policies = userPolicies(undefined, OFF);
  const skills = ['a', 'b', 'c'].map((resource) => ({ action: 'skill.use', resource, effect: 'deny' }));
  for (const skill of skills) policies = userPolicies([...policies, skill], OFF);
  assert.deepEqual(policies, [...skills, ...LOCKED]);
  assert.deepEqual(userPolicies([...LOCKED, skills[0], ...LOCKED, skills[1], ...LOCKED], OFF), [skills[0], skills[1], ...LOCKED]);
});

test('with other providers shown, only the lock goes and nothing of ours is added', () => {
  const own = [{ action: 'provider.use', resource: 'openai', effect: 'deny' }, { action: 'skill.use', resource: 'x', effect: 'deny' }];
  assert.deepEqual(userPolicies([...own, ...LOCKED], ON), own);
  assert.deepEqual(userPolicies([...LOCKED, ...own], ON), own);
  assert.deepEqual(userPolicies([...own, ALLOW_ALL], ON), own);
  assert.deepEqual(userPolicies(undefined, ON), []);
  assert.deepEqual(userPolicies(LOCKED, ON), []);
});

test('a rule of the person\'s own that only resembles one of ours stays', () => {
  const openai = { action: 'provider.use', resource: 'openai', effect: 'allow' };
  const noOpenai = { action: 'provider.use', resource: 'openai', effect: 'deny' };
  for (const own of [[DENY_ALL, openai], [ALLOW_MITTR], [openai, DENY_ALL], [DENY_ALL, openai, ALLOW_MITTR], [ALLOW_ALL, noOpenai], [null, 'text']]) {
    assert.deepEqual(userPolicies(own, ON), own);
    assert.deepEqual(userPolicies(own, OFF), [...own, ...LOCKED]);
    assert.deepEqual(userPolicies(userPolicies(own, OFF), ON), own);
  }
});

test('the user config is written only when its policies change', () => {
  let file = { theme: 'dark', policies: [ALLOW_ALL] };
  const writes = [];
  const userConfig = { read: () => structuredClone(file), write: (config) => { writes.push(config); file = structuredClone(config); } };
  assert.equal(syncUserConfigLock({ userConfig, showOtherProviders: false }), true);
  assert.deepEqual(file, { theme: 'dark', policies: LOCKED });
  assert.equal(syncUserConfigLock({ userConfig, showOtherProviders: false }), false);
  assert.equal(writes.length, 1);
});

test('with other providers shown, the lock leaves the user config with no empty list behind, and a file without it is never written', () => {
  const synced = (file) => {
    const writes = [];
    syncUserConfigLock({ userConfig: { read: () => structuredClone(file), write: (config) => writes.push(config) }, ...ON });
    return writes;
  };
  const disabled = { theme: 'dark', disabled_providers: ['openai'] };
  assert.deepEqual(synced({ ...disabled, policies: LOCKED }), [disabled]);
  assert.deepEqual(synced({ ...disabled, policies: [DENY_ALL, { action: 'skill.use', resource: 'x', effect: 'deny' }] }), []);
  assert.deepEqual(synced(disabled), []);
  assert.deepEqual(synced({}), []);
  assert.deepEqual(synced({ policies: [] }), []);
  assert.deepEqual(synced({ policies: 'not a list' }), []);
});

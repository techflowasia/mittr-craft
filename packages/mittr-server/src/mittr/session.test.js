import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSession } from './session.js';

const valid = {
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresAt: 1_800_000,
  subject: { userId: 'u1', displayName: 'A' },
};

test('parseSession keeps only the known fields', () => {
  assert.deepEqual(parseSession({ ...valid, serverSecret: 'must not survive', subject: { ...valid.subject, role: 'x' } }), valid);
});

test('parseSession rejects a payload that cannot authenticate', () => {
  const cases = {
    null: null,
    'a string': 'nope',
    'an array': [],
    'no access token': { ...valid, accessToken: '' },
    'no refresh token': { ...valid, refreshToken: undefined },
    'a non-numeric expiry': { ...valid, expiresAt: 'soon' },
    'an infinite expiry': { ...valid, expiresAt: Infinity },
    'no subject': { ...valid, subject: undefined },
    'a subject with no user id': { ...valid, subject: { displayName: 'x' } },
  };
  for (const [label, payload] of Object.entries(cases)) assert.throws(() => parseSession(payload), Error, label);
});

test('parseSession tolerates a missing display name', () => {
  assert.equal(parseSession({ ...valid, subject: { userId: 'u1' } }).subject.displayName, '');
});

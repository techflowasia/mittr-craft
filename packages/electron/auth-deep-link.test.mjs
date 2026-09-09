import assert from 'node:assert/strict';
import test from 'node:test';
import { isAuthCallbackLink } from './auth-deep-link.mjs';

test('accepts the auth callback', () => {
  assert.equal(isAuthCallbackLink({ type: 'auth', value: 'callback', raw: 'mittrcraft://auth/callback?code=x' }), true);
});

test('leaves the pairing link to the branch that owns it', () => {
  assert.equal(isAuthCallbackLink({ type: 'connect', value: '', raw: 'mittrcraft://connect?v=2' }), false);
});

test('ignores an auth link on another path', () => {
  assert.equal(isAuthCallbackLink({ type: 'auth', value: 'logout', raw: 'mittrcraft://auth/logout' }), false);
  assert.equal(isAuthCallbackLink({ type: 'auth', value: '', raw: 'mittrcraft://auth' }), false);
});

test('ignores anything malformed', () => {
  assert.equal(isAuthCallbackLink(null), false);
  assert.equal(isAuthCallbackLink(undefined), false);
  assert.equal(isAuthCallbackLink({}), false);
  assert.equal(isAuthCallbackLink({ type: 'auth', value: 'callback' }), false);
});

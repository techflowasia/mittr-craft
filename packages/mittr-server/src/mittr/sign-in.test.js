import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { TRANSACTION_TTL_MS, authRedirectUri, createTransaction, deepLinkScheme, verifyCallback } from './sign-in.js';

const txAt = (ms) => createTransaction({ now: () => ms });
const DEV = { scheme: 'mittrcraft-dev' };

test('a transaction holds a verifier and the challenge derived from it', () => {
  const tx = createTransaction({ randomBytes: (size) => Buffer.alloc(size, 1), now: () => 42 });
  assert.equal(tx.verifier, '01'.repeat(32));
  assert.equal(tx.challenge, crypto.createHash('sha256').update(tx.verifier).digest('base64url'));
  assert.equal(tx.createdAt, 42);
  assert.notEqual(txAt(0).verifier, txAt(0).verifier);
});

test('a callback on the auth deep link carrying a code is accepted', () => {
  assert.deepEqual(verifyCallback(txAt(0), 'mittrcraft-dev://auth/callback?code=abc', { now: () => 1000, ...DEV }), { code: 'abc' });
});

test('each refused callback says why', () => {
  const at = (ms) => ({ now: () => ms, ...DEV });
  assert.throws(() => verifyCallback(null, 'mittrcraft-dev://auth/callback?code=a', at(1)), { message: 'No sign-in is in progress' });
  assert.throws(() => verifyCallback(txAt(0), 'not a url', at(1)), { message: 'Sign-in callback is not a valid URL' });
  for (const url of ['mittrcraft://auth/callback?code=a', 'https://evil.test/callback?code=a', 'mittrcraft-dev://connect/callback?code=a']) {
    assert.throws(() => verifyCallback(txAt(0), url, at(1)), { message: 'Sign-in callback did not arrive on the auth deep link' }, url);
  }
  assert.throws(() => verifyCallback(txAt(0), 'mittrcraft-dev://auth/callback?code=a', at(TRANSACTION_TTL_MS + 1)), { message: 'Sign-in transaction expired' });
  assert.throws(() => verifyCallback(txAt(0), 'mittrcraft-dev://auth/callback?code=%20', at(1)), { message: 'Sign-in callback carried no code' });
  assert.equal(TRANSACTION_TTL_MS, 600_000);
});

test('the deep-link scheme defaults to mittrcraft and refuses anything that is not a scheme', () => {
  assert.equal(deepLinkScheme({}), 'mittrcraft');
  assert.equal(deepLinkScheme({ MITTRCRAFT_DEEP_LINK_SCHEME: ' ' }), 'mittrcraft');
  assert.equal(deepLinkScheme({ MITTRCRAFT_DEEP_LINK_SCHEME: 'MittrCraft-Dev' }), 'mittrcraft-dev');
  assert.throws(() => deepLinkScheme({ MITTRCRAFT_DEEP_LINK_SCHEME: 'bad scheme://' }), /not a valid URL scheme/);
  assert.equal(authRedirectUri('mittrcraft-dev'), 'mittrcraft-dev://auth/callback');
});

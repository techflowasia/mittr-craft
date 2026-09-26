import assert from 'node:assert/strict';
import test from 'node:test';
import { createSafeStorageSecretStore } from './secret-store.mjs';

const workingSafeStorage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`sealed:${text}`),
  decryptString: (buffer) => Buffer.from(buffer).toString('utf8').replace(/^sealed:/, ''),
});

test('returns null when the OS offers no encryption, so the server can say so', () => {
  assert.equal(createSafeStorageSecretStore({
    safeStorage: { ...workingSafeStorage(), isEncryptionAvailable: () => false },
  }), null);
});

test('returns null when there is no safeStorage at all', () => {
  assert.equal(createSafeStorageSecretStore({ safeStorage: null }), null);
});

test('round-trips through the OS keychain', () => {
  const store = createSafeStorageSecretStore({ safeStorage: workingSafeStorage() });
  const sealed = store.encrypt('session-json');
  assert.ok(Buffer.isBuffer(sealed));
  assert.equal(store.decrypt(sealed), 'session-json');
});

test('never returns the plaintext from encrypt', () => {
  const store = createSafeStorageSecretStore({ safeStorage: workingSafeStorage() });
  assert.doesNotMatch(store.encrypt('at-secret-value').toString('utf8'), /^at-secret-value$/);
});

test('treats a keychain that refuses at call time as unusable rather than crashing', () => {
  const store = createSafeStorageSecretStore({
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: () => { throw new Error('keychain locked'); },
      decryptString: () => { throw new Error('keychain locked'); },
    },
  });
  assert.throws(() => store.encrypt('x'), /keychain/i);
});

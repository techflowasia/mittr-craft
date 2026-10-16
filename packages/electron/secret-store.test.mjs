import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSafeStorageSecretStore } from './secret-store.mjs';

const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (text) => Buffer.from(`E${text}`),
  decryptString: (data) => data.toString().slice(1),
});

test('secret store round-trips through safeStorage', () => {
  const store = createSafeStorageSecretStore({ safeStorage: fakeSafeStorage() });
  const sealed = store.encrypt('tok');
  assert.ok(Buffer.isBuffer(sealed));
  assert.notEqual(sealed.toString(), 'tok');
  assert.equal(store.decrypt(sealed), 'tok');
});

test('secret store decrypts bytes that came back as a plain Uint8Array', () => {
  const store = createSafeStorageSecretStore({ safeStorage: fakeSafeStorage() });
  assert.equal(store.decrypt(new Uint8Array(store.encrypt('tok'))), 'tok');
});

test('no encryption means no store', () => {
  assert.equal(createSafeStorageSecretStore({ safeStorage: fakeSafeStorage(false) }), null);
  assert.equal(createSafeStorageSecretStore({ safeStorage: undefined }), null);
  assert.equal(createSafeStorageSecretStore({}), null);
});

test('a safeStorage that throws when asked means no store', () => {
  const safeStorage = { isEncryptionAvailable: () => { throw new Error('before ready'); } };
  assert.equal(createSafeStorageSecretStore({ safeStorage }), null);
});

test('encrypt refuses anything but a string, so a secret is never stringified by accident', () => {
  const store = createSafeStorageSecretStore({ safeStorage: fakeSafeStorage() });
  assert.throws(() => store.encrypt({ token: 'x' }), /string/);
});

test('a keyring that keeps its key in plain text means no store', () => {
  const backend = (name) => ({ ...fakeSafeStorage(), getSelectedStorageBackend: () => name });
  assert.equal(createSafeStorageSecretStore({ safeStorage: backend('basic_text') }), null);
  assert.ok(createSafeStorageSecretStore({ safeStorage: backend('gnome_libsecret') }));
  assert.ok(createSafeStorageSecretStore({ safeStorage: backend('unknown') }));
  const throwing = { ...fakeSafeStorage(), getSelectedStorageBackend: () => { throw new Error('not on this platform'); } };
  assert.ok(createSafeStorageSecretStore({ safeStorage: throwing }));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSafeStorageSecretStore } from './secret-store.mjs';

const fakeSafeStorage = (available = true) => {
  const calls = { isEncryptionAvailable: 0, getSelectedStorageBackend: 0, encryptString: 0, decryptString: 0 };
  return {
    calls,
    isEncryptionAvailable: () => {
      calls.isEncryptionAvailable += 1;
      return available;
    },
    encryptString: (text) => {
      calls.encryptString += 1;
      return Buffer.from(`E${text}`);
    },
    decryptString: (data) => {
      calls.decryptString += 1;
      return data.toString().slice(1);
    },
  };
};

const withBackend = (name) => {
  const safeStorage = fakeSafeStorage();
  safeStorage.getSelectedStorageBackend = () => {
    safeStorage.calls.getSelectedStorageBackend += 1;
    return name;
  };
  return safeStorage;
};

test('creating the store asks safeStorage nothing, so startup never waits on a keychain', () => {
  const safeStorage = withBackend('gnome_libsecret');
  const store = createSafeStorageSecretStore({ safeStorage });
  assert.ok(store);
  assert.deepEqual(safeStorage.calls, { isEncryptionAvailable: 0, getSelectedStorageBackend: 0, encryptString: 0, decryptString: 0 });
});

test('the first use checks availability once and every later use reuses the answer', () => {
  const safeStorage = withBackend('gnome_libsecret');
  const store = createSafeStorageSecretStore({ safeStorage });
  assert.equal(store.available(), true);
  store.decrypt(store.encrypt('tok'));
  store.encrypt('again');
  assert.equal(store.available(), true);
  assert.equal(safeStorage.calls.isEncryptionAvailable, 1);
  assert.equal(safeStorage.calls.getSelectedStorageBackend, 1);
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

test('no encryption is refused at first use, and the refusal is remembered', () => {
  const safeStorage = fakeSafeStorage(false);
  const store = createSafeStorageSecretStore({ safeStorage });
  assert.equal(store.available(), false);
  assert.throws(() => store.encrypt('tok'), /keychain/);
  assert.throws(() => store.decrypt(Buffer.from('Etok')), /keychain/);
  assert.equal(safeStorage.calls.isEncryptionAvailable, 1);
  assert.equal(safeStorage.calls.encryptString, 0);
  assert.equal(safeStorage.calls.decryptString, 0);
});

test('a missing safeStorage is a store that is never available', () => {
  for (const options of [{ safeStorage: undefined }, {}, undefined]) {
    const store = createSafeStorageSecretStore(options);
    assert.equal(store.available(), false);
    assert.throws(() => store.encrypt('tok'), /keychain/);
  }
});

test('a safeStorage that throws when asked is unavailable', () => {
  const safeStorage = { isEncryptionAvailable: () => { throw new Error('before ready'); } };
  const store = createSafeStorageSecretStore({ safeStorage });
  assert.equal(store.available(), false);
  assert.throws(() => store.encrypt('tok'), /keychain/);
});

test('encrypt refuses anything but a string, so a secret is never stringified by accident', () => {
  const store = createSafeStorageSecretStore({ safeStorage: fakeSafeStorage() });
  assert.throws(() => store.encrypt({ token: 'x' }), /string/);
});

test('a keyring that keeps its key in plain text is refused at first use', () => {
  const plain = withBackend('basic_text');
  const store = createSafeStorageSecretStore({ safeStorage: plain });
  assert.equal(store.available(), false);
  assert.throws(() => store.encrypt('tok'), /keychain/);
  assert.equal(plain.calls.encryptString, 0);
  assert.equal(createSafeStorageSecretStore({ safeStorage: withBackend('gnome_libsecret') }).available(), true);
  assert.equal(createSafeStorageSecretStore({ safeStorage: withBackend('unknown') }).available(), true);
  const throwing = { ...fakeSafeStorage(), getSelectedStorageBackend: () => { throw new Error('not on this platform'); } };
  assert.equal(createSafeStorageSecretStore({ safeStorage: throwing }).available(), true);
});

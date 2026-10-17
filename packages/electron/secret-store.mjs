const NO_KEYCHAIN = 'No secure keychain is available';

// On Linux without a keyring safeStorage still reports encryption available,
// with its key kept in plain text (`basic_text`); that is no secret store.
const keepsKeyInPlainText = (safeStorage) => {
  try {
    return safeStorage.getSelectedStorageBackend?.() === 'basic_text';
  } catch {
    return false;
  }
};

const canSeal = (safeStorage) => {
  if (!safeStorage) return false;
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
  } catch {
    return false;
  }
  return !keepsKeyInPlainText(safeStorage);
};

const RECHECK_AFTER_NO_MS = 5_000;

// Keychain-backed secrets for in-process server plugins. Electron's safeStorage
// seals a string with a key held by the operating system (Keychain on macOS,
// DPAPI on Windows, the secret service on Linux). The store hands out bytes the
// plugin may keep on disk; reading them back needs this same user session.
//
// Asking the system whether it can seal may raise a keychain dialog that blocks
// the main thread, so nothing is asked when the store is created. The first
// `available()`, `encrypt` or `decrypt` asks; a yes is kept for the run, and a
// no is asked again on the first use at least RECHECK_AFTER_NO_MS later, so a
// keychain dialog answered after the first ask gave up takes effect without a
// restart. While the answer is no, `encrypt` and `decrypt` throw instead of
// sealing nothing.
export function createSafeStorageSecretStore({ safeStorage, now = () => performance.now() } = {}) {
  let usable = false;
  let askedAt = null;
  const available = () => {
    if (usable) return true;
    if (askedAt !== null && now() - askedAt < RECHECK_AFTER_NO_MS) return false;
    usable = canSeal(safeStorage);
    askedAt = now();
    return usable;
  };
  const requireKeychain = () => {
    if (!available()) throw new Error(NO_KEYCHAIN);
  };
  return {
    available,
    encrypt(text) {
      if (typeof text !== 'string') throw new TypeError('A secret must be a string');
      requireKeychain();
      return safeStorage.encryptString(text);
    },
    decrypt(data) {
      requireKeychain();
      return safeStorage.decryptString(Buffer.isBuffer(data) ? data : Buffer.from(data));
    },
  };
}

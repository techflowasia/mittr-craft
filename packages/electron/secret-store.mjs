// Keychain-backed secrets for in-process server plugins. Electron's safeStorage
// seals a string with a key held by the operating system (Keychain on macOS,
// DPAPI on Windows, the secret service on Linux). The store hands out bytes the
// plugin may keep on disk; reading them back needs this same user session.
export function createSafeStorageSecretStore({ safeStorage } = {}) {
  if (!safeStorage) return null;
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
  } catch {
    return null;
  }
  return {
    encrypt(text) {
      if (typeof text !== 'string') throw new TypeError('A secret must be a string');
      return safeStorage.encryptString(text);
    },
    decrypt(data) {
      return safeStorage.decryptString(Buffer.isBuffer(data) ? data : Buffer.from(data));
    },
  };
}

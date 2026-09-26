/**
 * Hands the in-process server the OS keychain, which only the native side has.
 *
 * Returns null when the platform cannot encrypt — a Linux desktop with no
 * keyring, most often. The server then falls back to storing the session
 * unencrypted and says so in its log, which is a weaker position taken
 * knowingly rather than a sign-in that silently refuses to work.
 */
export const createSafeStorageSecretStore = ({ safeStorage }) => {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') return null;
  if (!safeStorage.isEncryptionAvailable()) return null;

  return {
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (buffer) => safeStorage.decryptString(Buffer.from(buffer)),
  };
};

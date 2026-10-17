export const NO_KEYCHAIN = "MittrCraft can't find a secure keychain on this computer to keep your sign-in safe.";

/**
 * For a runtime with no desktop host (hosted web, the CLI): the tokens sit on
 * disk readable by their owner (the account store writes mode 0600) and
 * nothing more. It warns once so the weakening shows in the log.
 */
export function plaintextSecretStore(logger = console) {
  let warned = false;
  return {
    encrypt: (text) => {
      if (!warned) {
        warned = true;
        logger.warn('[mittr] no keychain: Mittr tokens are stored unencrypted');
      }
      return Buffer.from(text, 'utf8');
    },
    decrypt: (data) => Buffer.from(data).toString('utf8'),
  };
}

const refusingSecretStore = () => {
  const refuse = () => {
    throw new Error(NO_KEYCHAIN);
  };
  return { encrypt: refuse, decrypt: refuse };
};

/**
 * The desktop seals Mittr tokens, which are company credentials, with the
 * keychain store the shell hands plugins, and never falls back to plain text:
 * without one (no keychain, or Linux's plain-text keyring) sign-in is refused
 * and tokens already on disk stay as they are.
 *
 * Whether the shell's store can seal is asked of it lazily (its optional
 * `available()`), never while this is being chosen: asking can raise a
 * keychain dialog, and the app must not wait on one before it has a window.
 * `refusal()` answers the reason sign-in is refused, or null, and asks on
 * each call; the shell's store keeps its first answer.
 */
export function chooseSecretStore({ host, logger = console }) {
  if (!host) return { ...plaintextSecretStore(logger), refusal: () => null };
  const shellStore = host.secretStore;
  if (!shellStore) return { ...refusingSecretStore(), refusal: () => NO_KEYCHAIN };
  const usable = () => {
    if (typeof shellStore.available !== 'function') return true;
    try {
      return shellStore.available() !== false;
    } catch {
      return false;
    }
  };
  const sealedBy = (method) => (data) => {
    if (!usable()) throw new Error(NO_KEYCHAIN);
    return shellStore[method](data);
  };
  return {
    encrypt: sealedBy('encrypt'),
    decrypt: sealedBy('decrypt'),
    refusal: () => (usable() ? null : NO_KEYCHAIN),
  };
}

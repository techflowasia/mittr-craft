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
 * and tokens already on disk stay as they are. `refusal` carries the reason.
 */
export function chooseSecretStore({ host, logger = console }) {
  if (!host) return { ...plaintextSecretStore(logger), refusal: null };
  if (host.secretStore) {
    const { encrypt, decrypt } = host.secretStore;
    return { encrypt, decrypt, refusal: null };
  }
  return { ...refusingSecretStore(), refusal: NO_KEYCHAIN };
}

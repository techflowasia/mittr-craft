import assert from 'node:assert/strict';
import test from 'node:test';

import { NO_KEYCHAIN, chooseSecretStore, plaintextSecretStore } from './secret-store.js';

const recordingLogger = () => {
  const warnings = [];
  return { warnings, warn: (...args) => warnings.push(args.join(' ')), log: () => {} };
};

test('the plaintext store round-trips and warns once', () => {
  const logger = recordingLogger();
  const store = plaintextSecretStore(logger);
  const sealed = store.encrypt('r1');
  store.encrypt('r2');
  assert.equal(store.decrypt(sealed), 'r1');
  assert.equal(store.decrypt(new Uint8Array(sealed)), 'r1');
  assert.deepEqual(logger.warnings, ['[mittr] no keychain: Mittr tokens are stored unencrypted']);
});

test('a desktop uses the keychain store it is given', () => {
  const secretStore = { encrypt: (text) => Buffer.from(`E${text}`), decrypt: (data) => Buffer.from(data).toString().slice(1) };
  const chosen = chooseSecretStore({ host: { secretStore }, logger: recordingLogger() });
  assert.equal(chosen.refusal, null);
  assert.equal(chosen.decrypt(chosen.encrypt('r1')), 'r1');
});

test('a desktop without a keychain refuses instead of falling back to plain text', () => {
  const logger = recordingLogger();
  const chosen = chooseSecretStore({ host: { secretStore: null }, logger });
  assert.equal(chosen.refusal, NO_KEYCHAIN);
  assert.equal(NO_KEYCHAIN, 'This Mac has no keychain available for MittrCraft to store your sign-in safely');
  assert.throws(() => chosen.encrypt('r1'), { message: NO_KEYCHAIN });
  assert.throws(() => chosen.decrypt(Buffer.from('x')), { message: NO_KEYCHAIN });
  assert.deepEqual(logger.warnings, []);
});

test('a runtime with no desktop host keeps tokens in plain text, with the warning', () => {
  const logger = recordingLogger();
  const chosen = chooseSecretStore({ host: null, logger });
  assert.equal(chosen.refusal, null);
  assert.equal(chosen.encrypt('r1').toString('utf8'), 'r1');
  assert.equal(logger.warnings.length, 1);
});

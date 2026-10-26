import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readSecretFiles } from './secret-files.js';

const tempFile = (t, content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-secret-file-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'secret');
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
};

test('a secret file wins over the plain variable, loses one trailing line break and leaves its own name behind', (t) => {
  const env = {
    MITTR_AD_CLIENT_SECRET: 'plain-secret',
    MITTR_AD_CLIENT_SECRET_FILE: tempFile(t, 'file-secret\n'),
    MITTR_AD_BIND_PASSWORD_FILE: tempFile(t, ' spaced pass \r\n'),
    MITTR_AD_CLIENT_ID: 'app',
  };
  assert.deepEqual(readSecretFiles(env), {
    MITTR_AD_CLIENT_SECRET: 'file-secret',
    MITTR_AD_BIND_PASSWORD: ' spaced pass ',
    MITTR_AD_CLIENT_ID: 'app',
  });
  assert.equal(env.MITTR_AD_CLIENT_SECRET, 'plain-secret');
});

test('without a secret file the plain variables are used as they are, and a blank file setting counts as unset', () => {
  assert.deepEqual(readSecretFiles({ MITTR_AD_CLIENT_SECRET: 'plain', MITTR_AD_CLIENT_SECRET_FILE: '  ' }), { MITTR_AD_CLIENT_SECRET: 'plain' });
  assert.deepEqual(readSecretFiles({}), {});
});

test('a secret file that cannot be read is refused by name, with no path or content in the message', () => {
  assert.throws(
    () => readSecretFiles({ MITTR_AD_BIND_PASSWORD_FILE: '/nowhere/bind-password' }),
    (error) => error.message === 'MITTR_AD_BIND_PASSWORD_FILE names a file that could not be read (ENOENT); refusing to start without company sign-in',
  );
});

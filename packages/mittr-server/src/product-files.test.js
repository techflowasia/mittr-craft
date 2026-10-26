import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { applyProductEnv, readProduct } from '../../electron/product.mjs';

const BRAND_DIR = path.resolve(import.meta.dirname, '../../../brand');
const HOME = '/home/someone';
const APP_PATH = '/opt/app/resources/app';

const productFrom = (name) => {
  const text = fs.readFileSync(path.join(BRAND_DIR, name), 'utf8');
  const files = { [path.join(APP_PATH, 'product.json')]: text };
  return readProduct({
    appPath: APP_PATH,
    homeDir: HOME,
    fs: {
      readFileSync(file) {
        if (!Object.hasOwn(files, file)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
        return files[file];
      },
    },
  });
};

test('the prod product fixes the Mittr broker and ignores a launch override', () => {
  const product = productFrom('product.prod.json');
  const env = { MITTRCRAFT_BROKER_URL: 'https://example.invalid' };
  applyProductEnv(product, env);
  assert.equal(env.MITTRCRAFT_BROKER_URL, 'https://api.mittr.asia');
  assert.equal(env.MITTRCRAFT_BROKER_FIXED, '1');
});

test('the Dev product defaults to the dev platform', () => {
  const product = productFrom('product.dev.json');

  const unset = {};
  applyProductEnv(product, unset);
  assert.equal(unset.MITTRCRAFT_BROKER_URL, 'https://api-dev.mittr.asia');
  assert.equal(Object.hasOwn(unset, 'MITTRCRAFT_BROKER_FIXED'), false);

  const launched = { MITTRCRAFT_BROKER_URL: 'http://127.0.0.1:3000' };
  applyProductEnv(product, launched);
  assert.equal(launched.MITTRCRAFT_BROKER_URL, 'http://127.0.0.1:3000');
});

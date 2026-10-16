import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { repoRoot } from '../upstream-contract.js';
import { resolveBroker } from './broker.js';

test('without a broker URL the broker is prod', () => {
  assert.deepEqual(resolveBroker({}), { baseUrl: 'https://api.mittr.asia', upstreamV1: 'https://api.mittr.asia/v1', fixed: false });
});

test('a Dev or local run may point the broker and the upstream elsewhere', () => {
  assert.deepEqual(resolveBroker({ MITTRCRAFT_BROKER_URL: 'https://api-dev.mittr.asia' }), {
    baseUrl: 'https://api-dev.mittr.asia',
    upstreamV1: 'https://api-dev.mittr.asia/v1',
    fixed: false,
  });
  assert.deepEqual(resolveBroker({ MITTRCRAFT_BROKER_URL: 'http://127.0.0.1:3000/', MITTRCRAFT_UPSTREAM_URL: 'http://localhost:4000/v1/' }), {
    baseUrl: 'http://127.0.0.1:3000',
    upstreamV1: 'http://localhost:4000/v1',
    fixed: false,
  });
});

test('a broker URL that is not https outside loopback, or not an origin, is refused', () => {
  assert.throws(() => resolveBroker({ MITTRCRAFT_BROKER_URL: 'http://api.mittr.asia' }), /https outside loopback/);
  assert.throws(() => resolveBroker({ MITTRCRAFT_BROKER_URL: 'https://api.mittr.asia/api' }), /origin with no path/);
  assert.throws(() => resolveBroker({ MITTRCRAFT_BROKER_URL: 'https://api.mittr.asia/?x=1' }), /origin with no path/);
  assert.throws(() => resolveBroker({ MITTRCRAFT_BROKER_URL: 'nope' }), /not a valid URL/);
  assert.throws(() => resolveBroker({ MITTRCRAFT_UPSTREAM_URL: 'http://example.com/v1' }), /https outside loopback/);
});

test('prod broker ignores a launch override', async () => {
  const { readProduct, applyProductEnv } = await import(pathToFileURL(path.join(repoRoot, 'packages/electron/product.mjs')).href);
  const brand = fs.readFileSync(path.join(repoRoot, 'brand/product.prod.json'), 'utf8');
  const appPath = '/app';
  const product = readProduct({
    appPath,
    fs: { readFileSync: (file) => (file === path.join(appPath, 'product.json') ? brand : assert.fail(file)) },
    homeDir: '/home/someone',
  });
  const env = { MITTRCRAFT_BROKER_URL: 'https://example.invalid', MITTRCRAFT_UPSTREAM_URL: 'https://x.invalid' };
  applyProductEnv(product, env);
  assert.equal(env.MITTRCRAFT_BROKER_URL, 'https://api.mittr.asia');
  assert.deepEqual(resolveBroker(env), { baseUrl: 'https://api.mittr.asia', upstreamV1: 'https://api.mittr.asia/v1', fixed: true });
});

test('the Dev product points at the dev platform unless a launch says otherwise', async () => {
  const { readProduct, applyProductEnv } = await import(pathToFileURL(path.join(repoRoot, 'packages/electron/product.mjs')).href);
  const brand = fs.readFileSync(path.join(repoRoot, 'brand/product.dev.json'), 'utf8');
  const product = readProduct({ appPath: '/app', fs: { readFileSync: () => brand }, homeDir: '/home/someone' });
  const plain = {};
  applyProductEnv(product, plain);
  assert.deepEqual(resolveBroker(plain), { baseUrl: 'https://api-dev.mittr.asia', upstreamV1: 'https://api-dev.mittr.asia/v1', fixed: false });
  const local = { MITTRCRAFT_BROKER_URL: 'http://127.0.0.1:9' };
  applyProductEnv(product, local);
  assert.equal(resolveBroker(local).baseUrl, 'http://127.0.0.1:9');
});

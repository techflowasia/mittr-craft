import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const afterPack = require('./after-pack.cjs');

const WEB = 'node_modules/@openchamber/web';
const UNPACKED = [
  'lib/git/credential-helper.js',
  'lib/git/credential-helper-runtime.js',
  'lib/git/ssh-wrapper.js',
  'lib/git/ssh-wrapper-runtime.js',
  'lib/git/repository-credential-helper.js',
  'lib/git/repository-credential-helper-runtime.js',
  'built-in-extensions/registry.json',
].map((file) => ({ path: `${WEB}/build/server/${file}`, unpacked: true }));

const packedApp = (extra = []) => [
  ...['dist-bundle/entry.mjs', 'dist-bundle/main.mjs', 'dist-bundle/early-startup.mjs', 'preload.mjs', 'browser-panel-preload.cjs', 'package.json'].map((file) => ({ path: file })),
  ...[`${WEB}/package.json`, `${WEB}/build/server/index.js`, `${WEB}/build/server/index.js.map`, `${WEB}/build/bin/cli.js`].map((file) => ({ path: file })),
  ...UNPACKED,
  ...extra.map((file) => ({ path: file })),
];

const target = { platform: 'darwin', arch: 'arm64' };

test('the product file, its splash logo and the product plugins pass upstream\'s packed-contents check', () => {
  const files = packedApp(['product.json', 'mittrcraft-splash.svg', 'product-plugins/mittr-server.mjs']);
  assert.deepEqual(afterPack.productContentProblems(files, target, 'mittrcraft-splash.svg'), []);
});

test('anything else at the app root, or the server source, still fails the check', () => {
  const stray = afterPack.productContentProblems(packedApp(['notes.txt', 'other.svg']), target, 'mittrcraft-splash.svg');
  assert.equal(stray.length, 1);
  assert.match(stray[0], /2 unexpected files outside node_modules \(notes\.txt, other\.svg\)/);
  const source = afterPack.productContentProblems(packedApp([`${WEB}/server/index.js`]), target, undefined);
  assert.deepEqual(source, [`${WEB}/server must not be packaged (1 files found)`]);
  const missing = afterPack.productContentProblems(packedApp().filter((file) => file.path !== `${WEB}/build/server/index.js`), target, undefined);
  assert.deepEqual(missing, [`${WEB}/build/server/index.js is missing`]);
});

test('only the root names the product packs count as product files', () => {
  assert.equal(afterPack.isProductFile('product.json', 'splash.svg'), true);
  assert.equal(afterPack.isProductFile('product-plugins/mittr-server.mjs', 'splash.svg'), true);
  assert.equal(afterPack.isProductFile('splash.svg', 'splash.svg'), true);
  assert.equal(afterPack.isProductFile('splash.svg', undefined), false);
  assert.equal(afterPack.isProductFile('dist-bundle/product.json', 'splash.svg'), false);
});

test('both flavors run the hook, which gives the executable its own UUID and leaves out upstream\'s icon catalog', () => {
  for (const flavor of ['dev', 'prod']) {
    const overlay = JSON.parse(fs.readFileSync(path.join(repoRoot, 'brand', `electron-builder.${flavor}.json`), 'utf8'));
    assert.equal(path.resolve(repoRoot, 'packages/electron', overlay.afterPack), path.join(repoRoot, 'scripts/mittr/after-pack.cjs'), flavor);
  }
  const source = fs.readFileSync(path.join(repoRoot, 'scripts/mittr/after-pack.cjs'), 'utf8');
  assert.ok(source.includes('setExecutableUuid(executablePath, appInfo.id)'));
  assert.equal(source.includes('Assets.car'), false);
});

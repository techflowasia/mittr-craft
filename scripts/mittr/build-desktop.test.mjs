import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyVisibleStrings, mergeBuilderConfig } from './build-desktop.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(repoRoot, relative), 'utf8'));

test('the brand overlay keeps upstream packaging and changes only our keys', () => {
  const upstream = readJson('packages/electron/package.json').build;
  const merged = mergeBuilderConfig(upstream, readJson('brand/electron-builder.dev.json'));

  assert.equal(merged.appId, 'dev.mittrcraft.desktop.dev');
  assert.equal(merged.productName, 'MittrCraft Dev');
  assert.equal(merged.publish, null);
  assert.equal(merged.afterPack, null);
  assert.deepEqual(merged.asarUnpack, upstream.asarUnpack);
  assert.deepEqual(merged.mac.target, upstream.mac.target);
  assert.equal(merged.mac.entitlements, upstream.mac.entitlements);
  assert.equal(merged.mac.icon, '../../brand/icons/icon.icns');
  assert.equal('CFBundleIconName' in merged.mac.extendInfo, false);

  assert.deepEqual(merged.files.slice(0, upstream.files.length), upstream.files);
  assert.ok(merged.files.includes('product-plugins/**'));

  const resources = Object.fromEntries(merged.extraResources.map((entry) => [entry.to, entry.from]));
  assert.equal(resources['web-dist'], 'resources/web-dist');
  assert.equal(resources['opencode-cli'], 'resources/opencode-cli');
  assert.equal(resources['icons/tray'], '../../brand/icons/tray');
  assert.equal(resources['icons/tray/status'], 'resources/icons/tray/status');
  assert.equal(merged.extraResources.length, Object.keys(resources).length);
});

test('a merge leaves the upstream block untouched', () => {
  const upstream = { mac: { extendInfo: { CFBundleIconName: 'AppIcon' } }, files: ['a'] };
  mergeBuilderConfig(upstream, { mac: { extendInfo: { CFBundleIconName: null } }, files: ['b'] });
  assert.deepEqual(upstream, { mac: { extendInfo: { CFBundleIconName: 'AppIcon' } }, files: ['a'] });
});

const withBuildOutput = (files, run) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-visible-strings-'));
  try {
    for (const [relative, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, relative), text);
    }
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

test('visible strings replace every exact match in the globbed build output', () => {
  withBuildOutput({ 'dist-bundle/main.mjs': 'OpenChamber and OpenChamber', 'resources/web-dist/assets/a.js': 'x' }, (root) => {
    const applied = applyVisibleStrings({
      entries: [{ file: 'dist-bundle/*.mjs', from: 'OpenChamber', to: 'MittrCraft' }],
      rootDir: root,
    });
    assert.deepEqual(applied, [{ file: 'dist-bundle/*.mjs', from: 'OpenChamber', count: 2 }]);
    assert.equal(fs.readFileSync(path.join(root, 'dist-bundle/main.mjs'), 'utf8'), 'MittrCraft and MittrCraft');
  });
});

test('an entry that matches nothing fails the build', () => {
  withBuildOutput({ 'dist-bundle/main.mjs': 'nothing here' }, (root) => {
    assert.throws(
      () => applyVisibleStrings({ entries: [{ file: 'dist-bundle/*.mjs', from: 'OpenChamber', to: 'MittrCraft' }], rootDir: root }),
      /matched nothing/,
    );
  });
});

test('an entry outside the build output is refused', () => {
  withBuildOutput({ 'main.mjs': 'OpenChamber' }, (root) => {
    assert.throws(
      () => applyVisibleStrings({ entries: [{ file: 'main.mjs', from: 'OpenChamber', to: 'MittrCraft' }], rootDir: root }),
      /must start with/,
    );
  });
});

test('Dev keeps its engine apart from the installed app', () => {
  const dev = readJson('brand/product.dev.json').env;
  const prod = readJson('brand/product.prod.json').env;
  assert.equal(dev.MITTRCRAFT_ENGINE_HOME, '~/.config/mittrcraft-dev/engine');
  assert.equal(prod.MITTRCRAFT_ENGINE_HOME, undefined);
  for (const key of ['OPENCHAMBER_DATA_DIR', 'OPENCODE_CONFIG_DIR', 'OPENCHAMBER_POLICY_FILE', 'OPENCHAMBER_MANAGED_PROCESS_REGISTRY']) {
    assert.notEqual(dev[key], prod[key], key);
  }
});

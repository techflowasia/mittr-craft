import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyVisibleStrings, mergeBuilderConfig, readVisibleStrings, stagedServerFiles } from './build-desktop.mjs';

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
      entries: [{ file: 'dist-bundle/*.mjs', from: 'OpenChamber', to: 'MittrCraft', count: 2 }],
      rootDir: root,
    });
    assert.deepEqual(applied, [{ file: 'dist-bundle/*.mjs', from: 'OpenChamber', count: 2 }]);
    assert.equal(fs.readFileSync(path.join(root, 'dist-bundle/main.mjs'), 'utf8'), 'MittrCraft and MittrCraft');
  });
});

test('an entry that matches nothing fails the build', () => {
  withBuildOutput({ 'dist-bundle/main.mjs': 'nothing here' }, (root) => {
    assert.throws(
      () => applyVisibleStrings({ entries: [{ file: 'dist-bundle/*.mjs', from: 'OpenChamber', to: 'MittrCraft', count: 1 }], rootDir: root }),
      /expected 1 matches, found 0/,
    );
  });
});

test('a match count other than the expected one fails the build and writes nothing', () => {
  withBuildOutput({ 'dist-bundle/main.mjs': 'OpenChamber and OpenChamber' }, (root) => {
    assert.throws(
      () => applyVisibleStrings({ entries: [{ file: 'dist-bundle/*.mjs', from: 'OpenChamber', to: 'MittrCraft', count: 1 }], rootDir: root }),
      /"from":"OpenChamber".*expected 1 matches, found 2/,
    );
    assert.equal(fs.readFileSync(path.join(root, 'dist-bundle/main.mjs'), 'utf8'), 'OpenChamber and OpenChamber');
  });
});

test('an entry outside the build output is refused', () => {
  withBuildOutput({ 'main.mjs': 'OpenChamber' }, (root) => {
    assert.throws(
      () => applyVisibleStrings({ entries: [{ file: 'main.mjs', from: 'OpenChamber', to: 'MittrCraft', count: 1 }], rootDir: root }),
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

test('both flavors pack the splash logo their product file names', () => {
  for (const flavor of ['dev', 'prod']) {
    const { splashSvg } = readJson(`brand/product.${flavor}.json`);
    assert.ok(fs.existsSync(path.join(repoRoot, 'brand', splashSvg)), `${flavor}: brand/${splashSvg}`);
    const staged = readJson(`brand/electron-builder.${flavor}.json`).files
      .filter((entry) => entry.from === '.product')
      .flatMap((entry) => entry.filter);
    assert.ok(staged.includes(splashSvg), flavor);
  }
});

test('every visible-strings entry replaces an upstream name and keeps none', () => {
  for (const entry of readJson('brand/visible-strings.json')) {
    assert.match(entry.from, /OpenChamber|OpenCode|openchamber:\/\//, entry.from);
    assert.doesNotMatch(entry.to, /OpenChamber|OpenCode/, entry.to);
  }
});

test('a flavor file applies after the shared visible strings and may build on them', () => {
  const brand = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-brand-'));
  try {
    fs.writeFileSync(path.join(brand, 'visible-strings.json'), JSON.stringify([
      { file: 'dist-bundle/*.mjs', from: 'Open OpenChamber', to: 'Open MittrCraft', count: 1 },
    ]));
    fs.writeFileSync(path.join(brand, 'visible-strings.dev.json'), JSON.stringify([
      { file: 'dist-bundle/*.mjs', from: 'openchamber://', to: 'mittrcraft-dev://', count: 1 },
    ]));
    assert.deepEqual(readVisibleStrings('prod', brand).map((entry) => entry.to), ['Open MittrCraft']);
    const dev = readVisibleStrings('dev', brand);
    assert.deepEqual(dev.map((entry) => entry.to), ['Open MittrCraft', 'mittrcraft-dev://']);
    withBuildOutput({ 'dist-bundle/main.mjs': '"Open OpenChamber" at openchamber://session/1' }, (root) => {
      applyVisibleStrings({ entries: dev, rootDir: root });
      assert.equal(fs.readFileSync(path.join(root, 'dist-bundle/main.mjs'), 'utf8'), '"Open MittrCraft" at mittrcraft-dev://session/1');
    });
  } finally {
    fs.rmSync(brand, { recursive: true, force: true });
  }
});

test('each flavor points the links it emits at its own scheme and still blocks upstream\'s', () => {
  for (const flavor of ['dev', 'prod']) {
    const { deepLinkProtocol } = readJson(`brand/product.${flavor}.json`);
    const entries = readJson(`brand/visible-strings.${flavor}.json`);
    assert.ok(entries.length > 0, flavor);
    for (const entry of entries) {
      assert.match(entry.from, /openchamber(:|")/, `${flavor}: ${entry.from}`);
      assert.ok(entry.to.includes(`${deepLinkProtocol}:`) || entry.to.includes(`"${deepLinkProtocol}"`), `${flavor}: ${entry.to}`);
    }
    const blocked = entries.find((entry) => entry.from.includes('"openchamber-ui"'));
    assert.ok(blocked.to.includes('"openchamber"') && blocked.to.includes(`"${deepLinkProtocol}"`), flavor);
  }
});

test('the staged server is packed in place of the workspace copy, except the files upstream unpacks', () => {
  const upstream = readJson('packages/electron/package.json').build;
  const entries = stagedServerFiles(upstream.asarUnpack);
  const serverUnpacked = upstream.asarUnpack.filter((pattern) => pattern.startsWith('node_modules/@openchamber/web/server/'));
  assert.ok(serverUnpacked.length > 0);
  assert.equal(entries[0], '!node_modules/@openchamber/web/server{,/**}');
  for (const pattern of serverUnpacked) assert.ok(entries.includes(pattern), pattern);
  const mapped = entries.at(-1);
  assert.deepEqual([mapped.from, mapped.to], ['.product/web/server', 'node_modules/@openchamber/web/server']);
  assert.ok(mapped.filter.includes('!lib/git/credential-helper.js'));
  assert.ok(entries.includes('!node_modules/@openchamber/web/{dist,public}{,/**}'));
});

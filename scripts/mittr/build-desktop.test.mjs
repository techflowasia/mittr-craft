import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findNeedles } from './brand-leak-scan.mjs';
import { applyVisibleStrings, mergeBuilderConfig, planVisibleStrings, readVisibleStrings, stagedServerFiles } from './build-desktop.mjs';

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
      /"OpenChamber" in dist-bundle\/\*\.mjs: expected 1, found 0/,
    );
  });
});

test('a match count other than the expected one fails the build and writes nothing', () => {
  withBuildOutput({ 'dist-bundle/main.mjs': 'OpenChamber and OpenChamber' }, (root) => {
    assert.throws(
      () => applyVisibleStrings({ entries: [{ file: 'dist-bundle/*.mjs', from: 'OpenChamber', to: 'MittrCraft', count: 1 }], rootDir: root }),
      /"OpenChamber" in dist-bundle\/\*\.mjs: expected 1, found 2 \(dist-bundle\/main\.mjs×2\)/,
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

// Entries that leave out a link whose own code names nothing upstream, each
// with the entry that blanks the address the link would open.
const LEFT_OUT_LINKS = new Map([
  [
    '{className:"app-region-no-drag mt-6 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground",href:',
    '?"https://github.com/openchamber/openchamber/releases/latest":"https://opencode.ai/download",',
  ],
  ['("walkthrough.help.guide"),onClick:()=>{', '="https://docs.openchamber.dev/walkthrough/",'],
  [
    '," ",{{id}}.jsx({{id}},{onClick:()=>{{{id}}({{id}})},children:{{id}}("settings.classification.page.docsLink")})]',
    '="https://docs.openchamber.dev/classification-providers/",',
  ],
]);

test('every visible-strings entry replaces an upstream name or link and keeps none, or leaves out a link to one', () => {
  const entries = readJson('brand/visible-strings.json');
  for (const entry of entries) {
    assert.deepEqual(findNeedles(entry.to), [], entry.to);
    if (LEFT_OUT_LINKS.has(entry.from)) {
      assert.ok(entry.to.includes('hidden:!0') || entry.to.length < entry.from.length, entry.from);
      const blanked = entries.find((other) => other.from === LEFT_OUT_LINKS.get(entry.from));
      assert.deepEqual(findNeedles(blanked?.to ?? 'missing'), [], entry.from);
      assert.match(blanked?.to ?? '', /^[=?]["":,]*$/, entry.from);
      continue;
    }
    assert.notDeepEqual(findNeedles(entry.from), [], entry.from);
  }
});

test('{{id}} in an entry stands for one minified identifier, and the count still holds', () => {
  const entry = { file: 'dist-bundle/*.mjs', from: 'go(),{{id}}.open({{id}})]', to: ']', count: 2 };
  withBuildOutput({ 'dist-bundle/main.mjs': '[go(),s.open(jv)];[go(),$a.open(b2)];[go(),s.open(x.y)];' }, (root) => {
    applyVisibleStrings({ entries: [entry], rootDir: root });
    assert.equal(fs.readFileSync(path.join(root, 'dist-bundle/main.mjs'), 'utf8'), '[];[];[go(),s.open(x.y)];');
  });
  withBuildOutput({ 'dist-bundle/main.mjs': '[go(),s.open(jv)];' }, (root) => {
    assert.throws(() => applyVisibleStrings({ entries: [entry], rootDir: root }), /expected 2, found 1/);
  });
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

test('each flavor names itself, points the links it emits at its own scheme and still blocks upstream\'s', () => {
  for (const flavor of ['dev', 'prod']) {
    const { appName, deepLinkProtocol } = readJson(`brand/product.${flavor}.json`);
    const entries = readJson(`brand/visible-strings.${flavor}.json`);
    const isLink = (entry) => /openchamber(:|")/.test(entry.from);
    assert.ok(entries.some(isLink), flavor);
    for (const entry of entries.filter(isLink)) {
      assert.ok(entry.to.includes(`${deepLinkProtocol}:`) || entry.to.includes(`"${deepLinkProtocol}"`), `${flavor}: ${entry.to}`);
    }
    // The window title is the app's name, Dev or not.
    assert.ok(entries.some((entry) => entry.from === '="OpenChamber",' && entry.to === `="${appName}",`), flavor);
    for (const entry of entries.filter((entry) => !isLink(entry))) {
      assert.ok(entry.to.includes(`"${appName}"`), `${flavor}: ${entry.to}`);
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

// The pairing link the desktop builds, the desktop import that reads it back
// and the mobile gates, as they appear in the built UI. They are a wire
// contract with mobile clients and keep upstream's scheme until phase 5.
const PAIRING_CONTRACT = [
  '`openchamber://connect?${t.toString()}`',
  'if(n.protocol!=="openchamber:"||n.hostname!=="connect")return null',
  '!/^openchamber:\\/\\/connect\\/?$/i.test(n.slice(0,t))',
  'if(/^openchamber:\\/\\//i.test(e)){const s=Ia(e);return s?{pairing:s}:null}',
];

test('no brand replacement touches the pairing link, its desktop import or the mobile gates', () => {
  for (const flavor of ['dev', 'prod']) {
    for (const entry of readVisibleStrings(flavor)) {
      for (const fragment of PAIRING_CONTRACT) {
        assert.ok(!fragment.includes(entry.from), `${flavor}: ${JSON.stringify(entry.from)} would rewrite ${fragment}`);
      }
      assert.doesNotMatch(entry.from, /:\/\/connect|:\\\/\\\/connect|protocol!==/, `${flavor}: ${entry.from}`);
    }
  }
});

test('every entry whose count is off is reported in one error, and nothing is written', () => {
  withBuildOutput({ 'dist-bundle/main.mjs': 'Quit OpenChamber', 'resources/web-dist/assets/a.js': '"OpenCode" "OpenCode"' }, (root) => {
    const entries = [
      { file: 'dist-bundle/*.mjs', from: 'Quit OpenChamber', to: 'Quit MittrCraft', count: 1 },
      { file: 'dist-bundle/*.mjs', from: 'About OpenChamber', to: 'About MittrCraft', count: 1 },
      { file: 'resources/web-dist/assets/*.js', from: '"OpenCode"', to: '"Engine"', count: 1 },
    ];
    assert.throws(() => applyVisibleStrings({ entries, rootDir: root }), (error) => {
      assert.match(error.message, /2 of 3 entries do not match/);
      assert.match(error.message, /"About OpenChamber" in dist-bundle\/\*\.mjs: expected 1, found 0/);
      assert.match(error.message, /"\\"OpenCode\\"" in resources\/web-dist\/assets\/\*\.js: expected 1, found 2 \(resources\/web-dist\/assets\/a\.js×2\)/);
      return true;
    });
    assert.equal(fs.readFileSync(path.join(root, 'dist-bundle/main.mjs'), 'utf8'), 'Quit OpenChamber');
  });
});

test('a check after a build reads the text the build replaced, and server entries can read the source', () => {
  withBuildOutput({ 'dist-bundle/main.mjs': 'Quit OpenChamber', 'server-source/lib/a.js': "'OpenCode is restarting'" }, (root) => {
    const entries = [
      { file: 'dist-bundle/*.mjs', from: 'Quit OpenChamber', to: 'Quit MittrCraft', count: 1 },
      { file: '.product/web/server/lib/*.js', from: "'OpenCode is restarting'", to: "'The engine is restarting'", count: 1 },
    ];
    applyVisibleStrings({ entries: entries.slice(0, 1), rootDir: root });
    assert.equal(fs.readFileSync(path.join(root, 'dist-bundle/main.mjs'), 'utf8'), 'Quit MittrCraft');

    const sources = { '.product/web/server/': path.join(root, 'server-source') };
    const checked = planVisibleStrings({ entries, rootDir: root, sources });
    assert.deepEqual(checked.mismatches, []);
    assert.deepEqual(checked.results.map(({ found, files }) => [found, files]), [[1, ['dist-bundle/main.mjs×1']], [1, ['.product/web/server/lib/a.js×1']]]);
    assert.equal(fs.readFileSync(path.join(root, 'server-source/lib/a.js'), 'utf8'), "'OpenCode is restarting'");

    fs.writeFileSync(path.join(root, 'dist-bundle/main.mjs'), 'rebuilt without the string');
    assert.equal(planVisibleStrings({ entries: entries.slice(0, 1), rootDir: root }).mismatches.length, 1);
  });
});

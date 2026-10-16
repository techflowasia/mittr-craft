import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { classifyHits, loadAsar, loadTranslations, scanApp, scanSource } from './brand-leak-scan.mjs';

const NO_TRANSLATIONS = { keys: new Set(), values: new Map() };

const texts = (hits) => hits.map((hit) => hit.text);

test('a name inside a string literal is a hit; identifiers, comments and console text are not', () => {
  const source = [
    '// OpenChamber in a comment',
    'const OpenChamberLogo = () => "Quit OpenChamber?";',
    'console.warn("OpenCode is slow", `OpenCode ${x}`);',
    'const link = `openchamber://session/${id}`;',
  ].join('\n');
  const hits = scanSource({ file: 'web-dist/assets/a.js', source });
  assert.deepEqual(texts(hits), ['Quit OpenChamber?', 'openchamber://session/']);
  assert.deepEqual(hits.map((hit) => hit.line), [2, 4]);
});

test('links to upstream project, chat, social account and site are hits; our own links are not', () => {
  const source = [
    'const a = "https://github.com/openchamber/openchamber";',
    'const b = "https://discord.gg/ZYRSdnwwKA";',
    'const c = { href: "https://x.com/openchamber_dev", children: "@openchamber_dev" };',
    'const d = `https://docs.openchamber.dev/guide/${page}`;',
    'const e = "https://openchamber.dev";',
    'const f = "https://github.com/techflowasia/mittr-craft";',
    'const g = "openchamber.deviceSeeded.v1:";',
  ].join('\n');
  const hits = scanSource({ file: 'web-dist/assets/a.js', source });
  assert.deepEqual(hits.map((hit) => [hit.line, hit.text.slice(hit.start, hit.end)]), [
    [1, 'github.com/openchamber'],
    [2, 'discord.gg/'],
    [3, 'x.com/openchamber'],
    [3, '@openchamber_dev'],
    [4, 'openchamber.dev'],
    [5, 'openchamber.dev'],
  ]);
});

test('markup comments do not count, markup text does', () => {
  const source = [
    '<!-- OpenChamber logo -->',
    '<style>/* the OpenChamber cube */</style>',
    '<title>OpenChamber</title>',
  ].join('\n');
  const hits = scanSource({ file: 'web-dist/index.html', source });
  assert.deepEqual(hits.map((hit) => hit.line), [3]);
});

test('translation values the product plugin rewrites are explained, keys are ids, a kept name is a leak', () => {
  const source = 'const d={"a.title":"About OpenChamber","b.title":"OpenCode Go","c":"settings.openchamber.aboutOpenChamber"};';
  const translations = {
    keys: new Set(['a.title', 'b.title', 'settings.openchamber.aboutOpenChamber']),
    values: new Map([
      ['a.title', new Map([['About OpenChamber', ['About MittrCraft']]])],
      ['b.title', new Map([['OpenCode Go', ['OpenCode Go']]])],
    ]),
  };
  const result = classifyHits({ hits: scanSource({ file: 'web-dist/assets/en.js', source }), allowlist: [], translations });
  assert.deepEqual(texts(result.translated), ['About OpenChamber']);
  assert.deepEqual(texts(result.keys), ['settings.openchamber.aboutOpenChamber']);
  assert.deepEqual(result.leaks.map((hit) => [hit.text, hit.translation]), [['OpenCode Go', true]]);
});

test('the same text outside a dictionary entry is not taken for a translation', () => {
  const translations = {
    keys: new Set(['nav.general']),
    values: new Map([['nav.general', new Map([['OpenChamber', ['MittrCraft']]])]]),
  };
  const hits = scanSource({ file: 'web-dist/assets/a.js', source: 'document.title="OpenChamber";' });
  assert.equal(classifyHits({ hits, allowlist: [], translations }).leaks.length, 1);
});

test('an allowlist entry explains only the hits it covers', () => {
  const source = [
    'const a = { appName: "OpenChamber", title: "OpenChamber" };',
    'const b = ["OpenChamber", "MittrCraft"];',
    'log("kept the backup from before OpenCode 2", "OpenCode crashed");',
  ].join('\n');
  const hits = scanSource({ file: 'app.asar/dist-bundle/main.mjs', source });
  const allowlist = [
    { file: 'app.asar/dist-bundle/*.mjs', key: 'appName', snippet: 'OpenChamber', reason: 'default' },
    { file: 'app.asar/dist-bundle/main.mjs', snippet: '["OpenChamber", "MittrCraft"]', reason: 'mapping' },
    { file: 'app.asar/dist-bundle/main.mjs', snippet: 'before OpenCode 2', reason: 'log line' },
    { file: 'web-dist/assets/*.js', snippet: 'OpenCode crashed', reason: 'other file' },
  ];
  const result = classifyHits({ hits, allowlist, translations: NO_TRANSLATIONS });
  assert.deepEqual(result.allowlisted.map((hit) => hit.reason), ['default', 'mapping', 'log line']);
  assert.deepEqual(texts(result.leaks), ['OpenChamber', 'OpenCode crashed']);
  assert.deepEqual(result.leaks.map((hit) => hit.key), ['title', undefined]);
  assert.deepEqual(result.unusedAllowlist, [{ file: 'web-dist/assets/*.js', snippet: 'OpenCode crashed', reason: 'other file' }]);
});

test('a snippet covering one name in a literal does not explain another name in it', () => {
  const hits = scanSource({ file: 'web-dist/assets/a.js', source: 'x("Use OpenCode Console, not OpenChamber")' });
  const allowlist = [{ file: 'web-dist/assets/a.js', snippet: 'OpenCode Console', reason: 'phase-2' }];
  const result = classifyHits({ hits, allowlist, translations: NO_TRANSLATIONS });
  assert.equal(result.allowlisted.length, 1);
  assert.equal(result.leaks.length, 1);
  assert.equal(result.leaks[0].start, 'Use OpenCode Console, not '.length);
});

test('an allowlist entry needs a reason', () => {
  assert.throws(() => classifyHits({
    hits: [],
    allowlist: [{ file: 'a.js', snippet: 'OpenCode' }],
    translations: NO_TRANSLATIONS,
  }));
});

const writeFiles = (root, files) => {
  for (const [relative, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  }
};

const leftoverExtracts = () => new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('mittr-leak-scan-')));

test('scanApp reads the plist, the web UI, the app files and the web server in app.asar, and leaves nothing behind', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-leak-fixture-'));
  try {
    const appPath = path.join(root, 'Fixture.app');
    const resources = path.join(appPath, 'Contents', 'Resources');
    writeFiles(appPath, {
      'Contents/Info.plist': '<plist><dict><key>NSHumanReadableCopyright</key><string>Copyright MittrCraft</string></dict></plist>',
      'Contents/Resources/web-dist/index.html': '<!-- OpenChamber shell --><title>MittrCraft</title>',
      'Contents/Resources/web-dist/assets/main-Ab12Cd34.js': 'export const t="Quit OpenChamber?";',
      'Contents/Resources/web-dist/assets/logo.png': 'OpenChamber',
    });
    const asarSource = path.join(root, 'asar-source');
    writeFiles(asarSource, {
      'dist-bundle/main.mjs': 'export const product = { appName: "OpenChamber" };',
      'node_modules/dep/index.js': 'module.exports = "OpenCode";',
      'node_modules/@openchamber/web/server/lib/routes.js': 'res.json({ error: "OpenCode is restarting" });',
      'node_modules/@openchamber/web/server/lib/routes.test.js': 'expect("OpenCode is restarting");',
    });
    await loadAsar().createPackage(asarSource, path.join(resources, 'app.asar'));

    const before = leftoverExtracts();
    const result = scanApp({
      appPath,
      allowlist: [{ file: 'app.asar/dist-bundle/*.mjs', key: 'appName', snippet: 'OpenChamber', reason: 'default' }],
      translations: NO_TRANSLATIONS,
    });

    assert.equal(result.fileCount, 5);
    assert.deepEqual(result.leaks.map((hit) => `${hit.file}:${hit.line}:${hit.text}`), [
      'web-dist/assets/main-Ab12Cd34.js:1:Quit OpenChamber?',
      'app.asar/node_modules/@openchamber/web/server/lib/routes.js:1:OpenCode is restarting',
    ]);
    assert.deepEqual(result.allowlisted.map((hit) => hit.file), ['app.asar/dist-bundle/main.mjs']);
    assert.deepEqual(result.unusedAllowlist, []);
    assert.deepEqual([...leftoverExtracts()].filter((name) => !before.has(name)), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scanApp refuses a folder that is not a built app', () => {
  assert.throws(
    () => scanApp({ appPath: os.tmpdir(), allowlist: [], translations: NO_TRANSLATIONS }),
    /not a built app/,
  );
});

test('the real dictionaries: substituted names are translations, names the overrides keep are not', () => {
  const translations = loadTranslations();
  assert.ok(translations.keys.has('settings.view.nav.group.general'));
  const general = translations.values.get('settings.view.nav.group.general').get('OpenChamber');
  assert.ok(general.length > 1);
  assert.ok(general.every((shown) => shown === 'MittrCraft'));
  const policyConsole = translations.values.get('settings.providers.enterprisePolicyConsole');
  assert.ok([...policyConsole.values()].flat().some((shown) => shown.includes('OpenCode Console')));
});

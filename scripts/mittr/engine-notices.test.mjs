import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkNotices, noticeSection, readDriverPins } from './drivers.mjs';
import {
  ENGINE_NOTICES_HEADING,
  bundledPackageDirs,
  checkEngineNotices,
  collectEnginePackages,
  engineCachePresent,
  nativePackageDirs,
  readEngineNotices,
  readPackage,
  renderEngineNotices,
  splitPackages,
  writeEngineNotices,
} from './engine-notices.mjs';
import { checkVadNotices, readVadPins } from './vad-assets.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const tree = (t, files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-engine-notices-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
};

const entry = (name, overrides = {}) => ({ name, version: '1.0.0', licence: 'MIT', repository: '', author: '', parts: [], texts: [], ...overrides });

test('the packages are the ones whose code reached a bundle output', () => {
  const output = (...inputs) => ({ inputs: Object.fromEntries(inputs.map(([input, bytesInOutput]) => [input, { bytesInOutput }])) });
  const dirs = bundledPackageDirs({
    rootDir: '/work',
    metafile: {
      outputs: {
        a: output(['node_modules/.bun/x@1/node_modules/x/lib/a.js', 10], ['node_modules/.bun/x@1/node_modules/x/lib/b.js', 5], ['node_modules/unused/a.js', 0]),
        b: output(['../.cache/opencode-server/@s+sdk@1/package/sdk.mjs', 9], ['packages/electron/opencode-server/serve.mjs', 4], ['node_modules/@s/y/a.js', 1]),
      },
    },
  });
  assert.deepEqual(dirs, ['/work/node_modules/.bun/x@1/node_modules/x', '/.cache/opencode-server/@s+sdk@1/package', '/work/node_modules/@s/y']);
});

test('a native file is traced to the cached package version it was copied from', (t) => {
  const root = tree(t, {
    'assets/@s/native-darwin/lib/a.node': 'two',
    'assets/manifest.json': '{}',
    'cache/@s+native-darwin@1.0.0/package/lib/a.node': 'one',
    'cache/@s+native-darwin@2.0.0/package/lib/a.node': 'two',
  });
  const options = { assetsDir: path.join(root, 'assets'), cacheDir: path.join(root, 'cache') };
  assert.deepEqual(nativePackageDirs(options), [path.join(root, 'cache/@s+native-darwin@2.0.0/package')]);
  fs.writeFileSync(path.join(root, 'assets/@s/native-darwin/lib/a.node'), 'three');
  assert.throws(() => nativePackageDirs(options), /has the packed files of @s\/native-darwin/);
});

test('a licence comes from the package\'s own file, or from the licence its README prints', (t) => {
  const root = tree(t, {
    'a/package.json': { name: 'a', version: '1.2.3', license: 'MIT', repository: { url: 'git+https://github.com/o/a.git' }, author: { name: 'A B', email: 'a@example.test' } },
    'a/LICENSE': 'MIT text\r\nline\n\n',
    'a/NOTICE': 'notice\n',
    'a/README.md': '# a\n',
    'b/package.json': { name: 'b', version: '1.0.0', license: 'MIT', repository: 'o/b', author: 'B' },
    'b/README.md': '# b\n\nLicense\n-------\n\nCopyright (c) B\n\nPermission is hereby granted, free\n',
    'c/package.json': { name: 'c', version: '1.0.0', license: 'MIT' },
    'c/README.md': '# c\n\n## License\n\nMIT\n',
  });
  const a = readPackage(path.join(root, 'a'));
  assert.deepEqual([a.repository, a.author, [...a.texts].sort()], ['https://github.com/o/a', 'A B <a@example.test>', ['MIT text\nline', 'notice']]);
  const b = readPackage(path.join(root, 'b'));
  assert.deepEqual([b.repository, b.texts], ['https://github.com/o/b', ['Copyright (c) B\n\nPermission is hereby granted, free']]);
  assert.deepEqual(readPackage(path.join(root, 'c')).texts, []);
});

test('packages that are not under an open licence are held back, and the rest are listed', () => {
  const { listed, heldBack } = splitPackages([
    entry('b'), entry('@s/closed', { licence: 'SEE LICENSE IN README.md' }), entry('@s/open'), entry('a'), entry('a'), entry('none', { licence: '' }),
  ]);
  assert.deepEqual(listed.map(({ name }) => name), ['@s/open', 'a', 'b']);
  assert.deepEqual(heldBack.map(({ name }) => name), ['@s/closed', 'none']);
});

test('the section prints each licence text once, shares it inside a repository and says which packages ship none', () => {
  const section = renderEngineNotices([
    entry('@o/a', { repository: 'https://example.test/o', texts: ['TEXT O'] }),
    entry('@o/b', { repository: 'https://example.test/o' }),
    entry('@o/native', {}),
    entry('p', { parts: ['@o/native'], texts: ['TEXT P'] }),
    entry('q', { repository: 'https://example.test/q', author: 'Q' }),
  ]);
  assert.equal(section.split('TEXT O').length, 2);
  assert.match(section, /### Licence of @o\/a 1\.0\.0, @o\/b 1\.0\.0\n\n````\nTEXT O\n````/);
  assert.match(section, /### Licence of @o\/native 1\.0\.0, p 1\.0\.0\n\n````\nTEXT P\n````/);
  assert.match(section, /ship no licence file\n\n- `q` 1\.0\.0 \(MIT\), by Q; see `MIT` terms at its source, https:\/\/example\.test\/q\.\n$/);
});

test('writing the section replaces only itself, and the check fails when the engine bundles something else', (t) => {
  const listed = [entry('a', { texts: ['TEXT A'] })];
  const before = '# Third-party notices\n\n## other\n\nx\n\n## cua-driver\n\ny\n';
  const once = writeEngineNotices(before, renderEngineNotices(listed));
  assert.equal(once.replace(readEngineNotices(once), ''), before);
  assert.equal(writeEngineNotices(once, renderEngineNotices(listed)), once);
  assert.equal(noticeSection(once, 'cua-driver'), noticeSection(before, 'cua-driver'));
  assert.equal(noticeSection(once, 'other'), noticeSection(before, 'other'));

  const file = path.join(tree(t, { 'notices.md': once }), 'notices.md');
  assert.deepEqual(checkEngineNotices({ file, collect: () => ({ listed, heldBack: [] }) }).listed, listed);
  assert.throws(() => checkEngineNotices({ file, collect: () => ({ listed: [entry('a', { version: '2.0.0', texts: ['TEXT A'] })], heldBack: [] }) }), /does not match the packages the engine bundles/);
});

test('the notices carry every open package the engine bundles today', (t) => {
  if (!engineCachePresent()) return t.skip('the engine packages are not in the build cache');
  const { listed } = checkEngineNotices({ collect: collectEnginePackages });
  for (const name of ['@opencode/server', '@opencode/core', 'effect', '@silvia-odwyer/photon-node', '@ff-labs/fff-node', 'ffi-rs', '@parcel/watcher']) {
    assert.ok(listed.some((item) => item.name === name && item.licence !== ''), name);
  }
});

test('the engine section leaves the pinned notice sections alone', () => {
  const notices = fs.readFileSync(path.join(repoRoot, 'brand/THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.ok(notices.includes(`\n## ${ENGINE_NOTICES_HEADING}\n`));
  assert.doesNotThrow(() => checkNotices({ pins: readDriverPins() }));
  assert.doesNotThrow(() => checkVadNotices({ pins: readVadPins() }));
});

test('the build checks the engine notices once the engine is bundled', () => {
  const main = fs.readFileSync(path.join(repoRoot, 'scripts/mittr/build-desktop.mjs'), 'utf8');
  const body = main.slice(main.indexOf('const main = async () => {'));
  const check = body.indexOf('checkEngineNotices(');
  assert.ok(check > body.indexOf("run(bun, ['run', 'prepare:opencode-server'], electronDir)") && check < body.indexOf("step('5/8"), 'the engine notices are not checked in step 4');
});

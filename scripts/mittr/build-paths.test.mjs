import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BUILD_ROOT_PLACEHOLDER, findBuildPaths, stripBuildPaths, verifyNoBuildPaths } from './build-paths.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const tempTree = (t, files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-build-paths-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  return root;
};

const REPO = '/Users/builder/work/product';
const HOME = '/Users/builder';
const binary = Buffer.concat([Buffer.from([0xcf, 0xfa, 0, 0]), Buffer.from(`${REPO}/native.cc`)]);

test('the repository path a bundler wrote into build output becomes a path that names no machine', (t) => {
  const root = tempTree(t, {
    'dist-bundle/main.mjs': `var __dirname = "${REPO}/node_modules/x/src";`,
    'resources/opencode-server/chunks/a.mjs': `createRequire("${REPO}/a.js");load("${REPO}/b.js")`,
    'resources/opencode-server/chunks/clean.mjs': 'export {};',
    'resources/opencode-server/assets/native.node': binary,
    'elsewhere/main.mjs': `"${REPO}/kept"`,
  });
  const before = fs.statSync(path.join(root, 'resources/opencode-server/chunks/clean.mjs')).mtimeMs;
  const changed = stripBuildPaths({ rootDir: root, dirs: ['dist-bundle', 'resources/opencode-server', 'missing'], buildRoot: REPO });
  assert.deepEqual(changed, [{ file: 'dist-bundle/main.mjs', count: 1 }, { file: 'resources/opencode-server/chunks/a.mjs', count: 2 }]);
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
  assert.equal(read('dist-bundle/main.mjs'), `var __dirname = "${BUILD_ROOT_PLACEHOLDER}/node_modules/x/src";`);
  assert.equal(read('resources/opencode-server/chunks/a.mjs'), `createRequire("${BUILD_ROOT_PLACEHOLDER}/a.js");load("${BUILD_ROOT_PLACEHOLDER}/b.js")`);
  assert.equal(read('elsewhere/main.mjs'), `"${REPO}/kept"`);
  assert.ok(fs.readFileSync(path.join(root, 'resources/opencode-server/assets/native.node')).equals(binary));
  assert.equal(fs.statSync(path.join(root, 'resources/opencode-server/chunks/clean.mjs')).mtimeMs, before);
  assert.deepEqual(stripBuildPaths({ rootDir: root, dirs: ['dist-bundle', 'resources/opencode-server'], buildRoot: REPO }), []);
});

test('the placeholder stays an absolute path, which createRequire needs', () => {
  assert.equal(path.posix.isAbsolute(BUILD_ROOT_PLACEHOLDER), true);
  assert.equal(path.win32.isAbsolute(BUILD_ROOT_PLACEHOLDER), true);
});

test('a path matches only as a whole folder', () => {
  const paths = { buildRoot: REPO, homeDir: HOME };
  assert.deepEqual(findBuildPaths(`x ${REPO}/a ${HOME}/.bun/b`, paths), ['the repository folder', 'the home folder']);
  assert.deepEqual(findBuildPaths(`"${REPO}"`, paths), ['the repository folder', 'the home folder']);
  assert.deepEqual(findBuildPaths(`${HOME}-old/a ${HOME}s`, paths), []);
  assert.deepEqual(findBuildPaths('/Users/runner/work/a', paths), []);
});

const fakeApp = (t, resources, archived = {}) => {
  const appPath = tempTree(t, {
    ...Object.fromEntries(Object.entries(resources).map(([file, content]) => [`Contents/Resources/${file}`, content])),
    'Contents/Resources/app.asar': 'archive',
  });
  const asar = {
    listPackage: () => Object.keys(archived).map((file) => `/${file}`),
    statFile: (_archive, file) => (file === 'folder' ? { files: {} } : file === 'unpacked.mjs' ? { unpacked: true } : {}),
    extractFile: (_archive, file) => Buffer.from(archived[file]),
  };
  return { appPath, asar, buildRoot: REPO, homeDir: HOME };
};

test('a packed app with no text file that names the build machine passes', (t) => {
  const app = fakeApp(t, { 'web-dist/a.js': 'ok', 'native.node': binary }, { folder: '', 'unpacked.mjs': `${REPO}/x`, 'dist-bundle/main.mjs': 'ok' });
  assert.equal(verifyNoBuildPaths(app), 2);
});

test('a packed text file that names the repository or the home folder fails the build', (t) => {
  assert.throws(() => verifyNoBuildPaths(fakeApp(t, { 'opencode-server/chunks/a.mjs': `"${REPO}/x"` })), /Contents\/Resources\/opencode-server\/chunks\/a\.mjs: the repository folder/);
  assert.throws(() => verifyNoBuildPaths(fakeApp(t, {}, { 'node_modules/x/config.json': `"${HOME}/.cache"` })), /app\.asar\/node_modules\/x\/config\.json: the home folder/);
});

test('the build strips the paths before it replaces visible strings, and checks the packed app at the end', () => {
  const main = fs.readFileSync(path.join(repoRoot, 'scripts/mittr/build-desktop.mjs'), 'utf8');
  const body = main.slice(main.indexOf('const main = async () => {'));
  const strip = body.indexOf('stripBuildPaths(');
  assert.ok(strip > body.indexOf("run(bun, ['run', 'bundle:main'], electronDir)"), 'the paths are not stripped after the bundles exist');
  assert.ok(strip < body.indexOf("step('5/8"), 'the paths are stripped after the visible strings');
  assert.ok(body.indexOf('verifyNoBuildPaths(') > body.indexOf("step('8/8"), 'the packed app is not checked in step 8');
});

test('the desktop log does not load its renderer preload into pages', () => {
  const main = fs.readFileSync(path.join(repoRoot, 'packages/electron/main.mjs'), 'utf8');
  assert.deepEqual([...main.matchAll(/log\.initialize\((.*)\);/g)].map((match) => match[1]), ['{ preload: false }']);
});

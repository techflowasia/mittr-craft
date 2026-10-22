import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { noticeSection } from './drivers.mjs';
import {
  VAD_DIR,
  VAD_WEB_DIST,
  checkBundledOrtVersion,
  checkVadNotices,
  readVadPins,
  resolveVadSources,
  stageVadAssets,
  verifyPackedVadAssets,
} from './vad-assets.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const scratch = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const fixture = (t) => {
  const dir = scratch(t, 'p4t-vad-fixture-');
  const vadDir = path.join(dir, 'vad-web', 'dist');
  const ortDir = path.join(dir, 'ort', 'dist');
  fs.mkdirSync(vadDir, { recursive: true });
  fs.mkdirSync(ortDir, { recursive: true });
  const files = [
    ['vad.worklet.bundle.min.js', '@ricky0123/vad-web', vadDir],
    ['silero_vad_v5.onnx', '@ricky0123/vad-web', vadDir],
    ['ort-wasm-simd-threaded.mjs', 'onnxruntime-web', ortDir],
    ['ort-wasm-simd-threaded.wasm', 'onnxruntime-web', ortDir],
  ].map(([name, pkg, from]) => {
    const bytes = Buffer.from(`fixture ${name}`);
    fs.writeFileSync(path.join(from, name), bytes);
    return { name, package: pkg, version: '9.9.9', path: `dist/${name}`, sha256: sha256(bytes), bytes: bytes.length };
  });
  return { dir, vadDir, ortDir, pins: { files } };
};

const pinMessage = (name, expected) => `${name} is missing or does not match scripts/mittr/vad-assets.json (expected sha256 ${expected}).`;

const fixturePackedApp = (t, pins, mutate = (bytes) => bytes) => {
  const dir = scratch(t, 'p4t-vad-app-');
  const appPath = path.join(dir, 'MittrCraft Dev.app');
  const vad = path.join(appPath, 'Contents', 'Resources', 'web-dist', 'vad');
  fs.mkdirSync(vad, { recursive: true });
  for (const file of pins.files) fs.writeFileSync(path.join(vad, file.name), mutate(Buffer.from(`fixture ${file.name}`), file.name));
  return { appPath, vad };
};

test('the pin file holds the four runtime files 1.22 copied, read from the installed copies', () => {
  const pins = readVadPins();
  assert.deepEqual(pins.files.map((file) => [file.name, file.package, file.version, file.path, file.sha256]), [
    ['vad.worklet.bundle.min.js', '@ricky0123/vad-web', '0.0.31', 'dist/vad.worklet.bundle.min.js', '8a48fdc7429948a2fde3d29a84bb1a64c1f67b4ba578ccaa7548b7f989f06a74'],
    ['silero_vad_v5.onnx', '@ricky0123/vad-web', '0.0.31', 'dist/silero_vad_v5.onnx', '2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f'],
    ['ort-wasm-simd-threaded.mjs', 'onnxruntime-web', '1.30.0', 'dist/ort-wasm-simd-threaded.mjs', 'e13f7f94fc51b4ca72b12faeb1ee95f4ace6dfbc8939bc718aabdc0a27c4299b'],
    ['ort-wasm-simd-threaded.wasm', 'onnxruntime-web', '1.30.0', 'dist/ort-wasm-simd-threaded.wasm', '3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2'],
  ]);
  assert.deepEqual(pins.files.map((file) => file.bytes), [2480, 2327524, 24381, 14239897]);
});

test('mittr-ui declares both packages at the exact pinned versions', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/mittr-ui/package.json'), 'utf8'));
  assert.equal(manifest.dependencies['@ricky0123/vad-web'], '0.0.31');
  assert.equal(manifest.dependencies['onnxruntime-web'], '1.30.0');
});

test('the installed copies resolve from mittr-ui, onnxruntime-web 1.30.0 included, and match every pin', () => {
  const pins = readVadPins();
  const sources = resolveVadSources({ repoRoot });
  assert.equal(path.basename(sources.vadDir), 'dist');
  assert.equal(path.basename(sources.ortDir), 'dist');
  assert.equal(JSON.parse(fs.readFileSync(path.join(sources.ortDir, '..', 'package.json'), 'utf8')).version, '1.30.0');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'p4t-vad-real-'));
  try {
    const staged = stageVadAssets({ pins, sources, outDir: path.join(out, 'vad') });
    assert.deepEqual(staged.map((file) => path.basename(file)), pins.files.map((file) => file.name));
    for (const [index, file] of staged.entries()) assert.equal(sha256(fs.readFileSync(file)), pins.files[index].sha256);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('an onnxruntime-web other than the pinned one is refused when sources are resolved', (t) => {
  const dir = scratch(t, 'p4t-vad-resolve-');
  const write = (relative, text) => {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const manifest = (name, version, extra = {}) => JSON.stringify({ name, version, type: 'commonjs', ...extra });
  write('packages/mittr-ui/package.json', manifest('@mittrcraft/ui-plugin', '0.0.0'));
  write('packages/mittr-ui/node_modules/@ricky0123/vad-web/package.json', manifest('@ricky0123/vad-web', '0.0.31', { main: 'dist/index.js' }));
  write('packages/mittr-ui/node_modules/@ricky0123/vad-web/dist/index.js', 'module.exports = {};');
  write('packages/mittr-ui/node_modules/@ricky0123/vad-web/node_modules/onnxruntime-web/package.json', manifest('onnxruntime-web', '1.14.0', { main: 'dist/ort.node.min.js' }));
  write('packages/mittr-ui/node_modules/@ricky0123/vad-web/node_modules/onnxruntime-web/dist/ort.node.min.js', 'module.exports = {};');
  assert.throws(
    () => resolveVadSources({ repoRoot: dir }),
    { message: 'onnxruntime-web resolved from @ricky0123/vad-web is 1.14.0, not the pinned 1.30.0' },
  );
});

test('a file whose sha256 differs is refused with the exact message', (t) => {
  const { dir, vadDir, ortDir, pins } = fixture(t);
  const outDir = path.join(dir, 'out', 'vad');
  fs.writeFileSync(path.join(ortDir, 'ort-wasm-simd-threaded.wasm'), 'another build');
  const wasm = pins.files[3];
  assert.throws(() => stageVadAssets({ pins, sources: { vadDir, ortDir }, outDir }), { message: pinMessage(wasm.name, wasm.sha256) });
  assert.equal(fs.existsSync(outDir), false);

  fs.rmSync(path.join(vadDir, 'silero_vad_v5.onnx'));
  const model = pins.files[1];
  assert.throws(() => stageVadAssets({ pins, sources: { vadDir, ortDir }, outDir }), { message: pinMessage(model.name, model.sha256) });
  assert.equal(fs.existsSync(outDir), false);
});

test('the four files are staged beside the renderer, not in packages/web/public', (t) => {
  const { dir, vadDir, ortDir, pins } = fixture(t);
  const outDir = path.join(dir, 'electron', 'resources', VAD_WEB_DIST, VAD_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'stale.bin'), 'left behind');
  const staged = stageVadAssets({ pins, sources: { vadDir, ortDir }, outDir });
  assert.deepEqual(staged, pins.files.map((file) => path.join(outDir, file.name)));
  assert.deepEqual(fs.readdirSync(outDir).sort(), pins.files.map((file) => file.name).sort());
  for (const file of pins.files) assert.equal(sha256(fs.readFileSync(path.join(outDir, file.name))), file.sha256);
  assert.equal(VAD_WEB_DIST, 'web-dist');
  assert.equal(VAD_DIR, 'vad');

  const source = fs.readFileSync(path.join(repoRoot, 'scripts/mittr/vad-assets.mjs'), 'utf8');
  const build = fs.readFileSync(path.join(repoRoot, 'scripts/mittr/build-desktop.mjs'), 'utf8');
  assert.equal(/packages[/'", ]+web[/'", ]+public/.test(source + build), false);
  assert.equal(fs.existsSync(path.join(repoRoot, 'packages/web/public/vad')), false);
});

test('the packed files are checked under Resources/web-dist/vad with their pinned sha256 values', (t) => {
  const { pins } = fixture(t);
  const { appPath, vad } = fixturePackedApp(t, pins);
  assert.deepEqual(verifyPackedVadAssets({ appPath, pins }), pins.files.map((file) => path.join(vad, file.name)));

  fs.rmSync(path.join(vad, 'silero_vad_v5.onnx'));
  assert.throws(() => verifyPackedVadAssets({ appPath, pins }), { message: `the packed app has no vad/silero_vad_v5.onnx: ${path.join(vad, 'silero_vad_v5.onnx')}` });

  const changed = fixturePackedApp(t, pins, (bytes, name) => (name === 'ort-wasm-simd-threaded.mjs' ? Buffer.from('rewritten') : bytes));
  assert.throws(
    () => verifyPackedVadAssets({ appPath: changed.appPath, pins }),
    { message: `the packed vad/ort-wasm-simd-threaded.mjs has sha256 ${sha256(Buffer.from('rewritten'))}, not the pinned ${pins.files[2].sha256}` },
  );
});

test('a bundled ONNX Runtime chunk must carry the pinned version', (t) => {
  const pins = { files: [{ package: 'onnxruntime-web', version: '1.30.0' }] };
  const dir = scratch(t, 'p4t-vad-chunks-');
  const assets = path.join(dir, 'assets');
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(assets, 'index-a.js'), 'const x = "no runtime here";');
  assert.deepEqual(checkBundledOrtVersion({ webDist: dir, pins }), []);
  assert.throws(() => checkBundledOrtVersion({ webDist: dir, pins, required: true }), { message: 'no bundled chunk under web-dist/assets carries ONNX Runtime Web' });

  fs.writeFileSync(path.join(assets, 'ort-b.js'), 'var v="1.30.0";var p="ort-wasm-simd-threaded.mjs";');
  assert.deepEqual(checkBundledOrtVersion({ webDist: dir, pins, required: true }), ['ort-b.js']);

  fs.writeFileSync(path.join(assets, 'ort-c.js'), 'var v="1.14.0";var p="ort-wasm-simd-threaded.wasm";');
  assert.throws(() => checkBundledOrtVersion({ webDist: dir, pins }), { message: 'the bundled chunk assets/ort-c.js carries ONNX Runtime Web but not the pinned version 1.30.0' });
});

test('the notices hold the three licence texts with their pins', (t) => {
  const pins = readVadPins();
  assert.deepEqual(pins.notices.map((notice) => notice.heading), ['@ricky0123/vad-web', 'onnxruntime-web', 'Silero VAD model']);
  const text = fs.readFileSync(path.join(repoRoot, 'brand/THIRD_PARTY_NOTICES.md'), 'utf8');
  for (const notice of pins.notices) assert.equal(sha256(noticeSection(text, notice.heading)), notice.sha256, notice.heading);
  assert.doesNotThrow(() => checkVadNotices({ pins }));

  const vad = noticeSection(text, '@ricky0123/vad-web');
  assert.match(vad, /License: ISC/);
  assert.match(vad, /Source: https:\/\/github\.com\/ricky0123\/vad\n/);
  const ort = noticeSection(text, 'onnxruntime-web');
  assert.match(ort, /License: MIT/);
  assert.match(ort, /Source: https:\/\/github\.com\/Microsoft\/onnxruntime\n/);
  assert.ok(ort.includes('ONNX Runtime Web v1.30.0\nCopyright (c) Microsoft Corporation. All rights reserved.\nLicensed under the MIT License.'));
  const silero = noticeSection(text, 'Silero VAD model');
  assert.match(silero, /License: MIT/);
  assert.match(silero, /Source: https:\/\/github\.com\/snakers4\/silero-vad\n/);
  for (const section of [vad, ort, silero]) assert.match(section, /No license file shipped with this package; see `(ISC|MIT)` terms at its source\./);

  const edited = path.join(scratch(t, 'p4t-vad-notices-'), 'THIRD_PARTY_NOTICES.md');
  fs.writeFileSync(edited, text.replace('Licensed under the MIT License.', 'Licensed under another licence.'));
  assert.throws(() => checkVadNotices({ pins, file: edited }), /the onnxruntime-web section of brand\/THIRD_PARTY_NOTICES\.md has sha256 [0-9a-f]{64}, not the pinned [0-9a-f]{64}/);
  fs.writeFileSync(edited, text.replace('\n## Silero VAD model\n', '\n## Another model\n'));
  assert.throws(() => checkVadNotices({ pins, file: edited }), /has no Silero VAD model section/);
});

test('the installed ONNX Runtime bundle states the licence the notice quotes', () => {
  const { ortDir } = resolveVadSources({ repoRoot });
  const header = fs.readFileSync(path.join(ortDir, 'ort.bundle.min.mjs'), 'utf8').split('\n').slice(0, 5).join('\n');
  const notices = fs.readFileSync(path.join(repoRoot, 'brand/THIRD_PARTY_NOTICES.md'), 'utf8');
  for (const line of header.split('\n').filter((entry) => entry.startsWith(' * '))) assert.ok(notices.includes(line.slice(3)), line);
  assert.match(header, /ONNX Runtime Web v1\.30\.0/);
});

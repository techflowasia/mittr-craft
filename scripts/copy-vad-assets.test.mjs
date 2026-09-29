import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { VAD_FILES, copyVadAssets } from './copy-vad-assets.mjs';

const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), 'vad-assets-'));
  const vad = join(root, 'vad');
  const ort = join(root, 'ort');
  mkdirSync(vad);
  mkdirSync(ort);
  return { root, vad, ort, out: join(root, 'public', 'vad') };
};

const fill = (box, skip) => {
  for (const [source, name] of VAD_FILES) {
    if (name === skip) continue;
    writeFileSync(join(source === 'vad' ? box.vad : box.ort, name), name);
  }
};

test('copies the worklet, the model and the onnx runtime into the public vad directory', () => {
  const box = sandbox();
  try {
    fill(box);
    copyVadAssets({ vadDir: box.vad, ortDir: box.ort, outDir: box.out });
    assert.deepEqual(
      VAD_FILES.map(([, name]) => name),
      ['vad.worklet.bundle.min.js', 'silero_vad_v5.onnx', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'],
    );
    for (const [, name] of VAD_FILES) assert.equal(readFileSync(join(box.out, name), 'utf8'), name);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('fails and copies nothing when a source file is missing', () => {
  const box = sandbox();
  try {
    fill(box, 'silero_vad_v5.onnx');
    assert.throws(
      () => copyVadAssets({ vadDir: box.vad, ortDir: box.ort, outDir: box.out }),
      /silero_vad_v5\.onnx/,
    );
    assert.equal(existsSync(box.out), false);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

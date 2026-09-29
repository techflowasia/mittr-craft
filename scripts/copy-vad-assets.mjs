#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const VAD_OUT_DIR = join(repoRoot, 'packages', 'web', 'public', 'vad');

export const VAD_FILES = [
  ['vad', 'vad.worklet.bundle.min.js'],
  ['vad', 'silero_vad_v5.onnx'],
  ['ort', 'ort-wasm-simd-threaded.mjs'],
  ['ort', 'ort-wasm-simd-threaded.wasm'],
];

export const resolveVadSources = () => {
  const fromUi = createRequire(join(repoRoot, 'packages', 'ui', 'package.json'));
  const vadEntry = fromUi.resolve('@ricky0123/vad-web');
  const fromVad = createRequire(vadEntry);
  return { vadDir: dirname(vadEntry), ortDir: dirname(fromVad.resolve('onnxruntime-web')) };
};

export const copyVadAssets = ({ vadDir, ortDir, outDir }) => {
  const sources = VAD_FILES.map(([from, name]) => [join(from === 'vad' ? vadDir : ortDir, name), name]);
  const missing = sources.map(([path]) => path).filter((path) => !existsSync(path));
  if (missing.length > 0) throw new Error(`copy-vad-assets: missing ${missing.join(', ')}`);
  mkdirSync(outDir, { recursive: true });
  for (const [path, name] of sources) copyFileSync(path, join(outDir, name));
  return sources.map(([, name]) => join(outDir, name));
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    copyVadAssets({ ...resolveVadSources(), outDir: VAD_OUT_DIR });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

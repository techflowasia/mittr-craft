import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { engineBases } from './engine-home.js';
import { bundledRipgrep, engineRipgrepPath, placeEngineRipgrep } from './engine-ripgrep.js';

const tempDir = (t, prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const resourcesWithRipgrep = (t, bytes = '#!/bin/sh\necho ripgrep\n') => {
  const resources = tempDir(t, 'mittr-resources-');
  fs.mkdirSync(path.join(resources, 'ripgrep'));
  fs.writeFileSync(path.join(resources, 'ripgrep', 'rg'), bytes, { mode: 0o755 });
  return resources;
};

test('the bundled rg is the one under the app resources, and there is none without it', (t) => {
  const resources = resourcesWithRipgrep(t);
  assert.equal(bundledRipgrep(resources), path.join(resources, 'ripgrep', 'rg'));
  assert.equal(bundledRipgrep(tempDir(t, 'mittr-resources-empty-')), null);
  assert.equal(bundledRipgrep(undefined), null);
  assert.equal(bundledRipgrep(null), null);
});

test('the engine looks for rg in <XDG_CACHE_HOME>/opencode/bin, which is the shared engine cache', (t) => {
  const home = tempDir(t, 'mittr-home-');
  const bases = engineBases({ homeDir: home, env: {} });
  assert.equal(engineRipgrepPath(bases), path.join(home, '.cache', 'mittrcraft', 'engine', 'opencode', 'bin', 'rg'));
  const devBases = engineBases({ homeDir: home, env: { MITTRCRAFT_ENGINE_HOME: path.join(home, 'dev-engine') } });
  assert.equal(engineRipgrepPath(devBases), path.join(home, 'dev-engine', 'opencode', 'bin', 'rg'));
});

test('the bundled rg is put where the engine looks, executable, and replaced when it differs', (t) => {
  const home = tempDir(t, 'mittr-home-');
  const bases = engineBases({ homeDir: home, env: {} });
  const bundled = bundledRipgrep(resourcesWithRipgrep(t, 'bundled 15.1.0'));
  const target = engineRipgrepPath(bases);

  assert.equal(placeEngineRipgrep({ bundled, bases }), target);
  assert.equal(fs.readFileSync(target, 'utf8'), 'bundled 15.1.0');
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);

  fs.writeFileSync(target, 'downloaded by the engine');
  placeEngineRipgrep({ bundled, bases });
  assert.equal(fs.readFileSync(target, 'utf8'), 'bundled 15.1.0');

  const unchanged = fs.statSync(target).mtimeMs;
  placeEngineRipgrep({ bundled, bases });
  assert.equal(fs.statSync(target).mtimeMs, unchanged);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['rg']);
});

test('a copy with the right bytes that lost its execute bit is made executable again', (t) => {
  const home = tempDir(t, 'mittr-home-');
  const bases = engineBases({ homeDir: home, env: {} });
  const bundled = bundledRipgrep(resourcesWithRipgrep(t, 'bundled 15.1.0'));
  const target = engineRipgrepPath(bases);
  placeEngineRipgrep({ bundled, bases });
  fs.chmodSync(target, 0o644);

  placeEngineRipgrep({ bundled, bases });

  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(target, 'utf8'), 'bundled 15.1.0');
});

test('without a bundled rg nothing is written', (t) => {
  const home = tempDir(t, 'mittr-home-');
  const bases = engineBases({ homeDir: home, env: {} });
  assert.equal(placeEngineRipgrep({ bundled: null, bases }), null);
  assert.deepEqual(fs.readdirSync(home), []);
});

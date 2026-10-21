import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { TEMPORARY_FILE, writePrivateAtomic } from './private-file.js';
import { tempDataDir } from './test-helpers.js';

const tempsIn = (dir) => fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));

test('the file is written with mode 600', (t) => {
  const file = path.join(tempDataDir(t), 'secret.json');
  writePrivateAtomic(file, '{"a":1}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a file that was looser is replaced with one that is private', (t) => {
  const file = path.join(tempDataDir(t), 'secret.json');
  fs.writeFileSync(file, 'old', { mode: 0o644 });
  writePrivateAtomic(file, 'new');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('bytes are written as they are', (t) => {
  const file = path.join(tempDataDir(t), 'sealed.session');
  const bytes = Buffer.from([0, 255, 1, 254]);
  writePrivateAtomic(file, bytes);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('a failed rename leaves no temp file and the old content', (t) => {
  const dir = tempDataDir(t);
  const file = path.join(dir, 'secret.json');
  fs.writeFileSync(file, 'previous');
  const failing = { ...fs, renameSync: () => { throw Object.assign(new Error('rename failed'), { code: 'EXDEV' }); } };
  assert.throws(() => writePrivateAtomic(file, 'next', { fs: failing }), /rename failed/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'previous');
  assert.deepEqual(tempsIn(dir), []);
});

test('a failed write leaves no temp file and rethrows', (t) => {
  const dir = tempDataDir(t);
  const file = path.join(dir, 'secret.json');
  const failing = {
    ...fs,
    writeFileSync: (target) => {
      fs.writeFileSync(target, 'half');
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    },
  };
  assert.throws(() => writePrivateAtomic(file, 'next', { fs: failing }), /disk full/);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(tempsIn(dir), []);
});

test('a cleanup that fails too does not replace the original error', (t) => {
  const dir = tempDataDir(t);
  const file = path.join(dir, 'secret.json');
  const original = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  const failing = {
    ...fs,
    writeFileSync: () => { throw original; },
    rmSync: () => { throw Object.assign(new Error('cleanup failed'), { code: 'EBUSY' }); },
  };
  assert.throws(() => writePrivateAtomic(file, 'next', { fs: failing }), (error) => error === original);
});

test('two quick writes get different temp names', (t) => {
  const dir = tempDataDir(t);
  const file = path.join(dir, 'secret.json');
  const names = [];
  const recording = { ...fs, renameSync: (from, to) => { names.push(path.basename(from)); fs.renameSync(from, to); } };
  for (let i = 0; i < 50; i += 1) writePrivateAtomic(file, `v${i}`, { fs: recording });
  assert.equal(new Set(names).size, 50);
  for (const name of names) assert.match(name, TEMPORARY_FILE);
  assert.deepEqual(tempsIn(dir), []);
});

test('the temp name is the one the account store sweeps', () => {
  assert.match(`index.json.${process.pid}-0a1b2c3d.tmp`, TEMPORARY_FILE);
  assert.doesNotMatch('notes.tmp', TEMPORARY_FILE);
  assert.doesNotMatch('index.json', TEMPORARY_FILE);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findRipgrep, prepareCliEnvironment, startsServer } from './cli-env.js';

const tempDir = (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittrcraft-rg-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const stubRg = (dir, mode = 0o755) => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rg');
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode });
  fs.chmodSync(file, mode);
  return file;
};

const prepare = (env) => prepareCliEnvironment({ env, homeDir: '/home/person', pluginPath: '/opt/plugin.js', productEnv: {} });

test('rg on PATH is found, and the first one wins', (t) => {
  const root = tempDir(t);
  const first = stubRg(path.join(root, 'first'));
  stubRg(path.join(root, 'second'));
  const joined = [path.join(root, 'missing'), path.join(root, 'first'), path.join(root, 'second')].join(path.delimiter);

  assert.equal(findRipgrep(joined, { fs }), first);
});

test('a PATH without an executable rg finds nothing', (t) => {
  const root = tempDir(t);
  stubRg(path.join(root, 'plain'), 0o644);
  fs.mkdirSync(path.join(root, 'dir', 'rg'), { recursive: true });
  const joined = [path.join(root, 'plain'), path.join(root, 'dir'), '', path.join(root, 'absent')].join(path.delimiter);

  assert.equal(findRipgrep(joined, { fs }), null);
  assert.equal(findRipgrep('', { fs }), null);
  assert.equal(findRipgrep(undefined, { fs }), null);
});

test('prepareCliEnvironment reports whether rg is on the PATH it hands on', (t) => {
  const root = tempDir(t);
  const rg = stubRg(path.join(root, 'bin'));

  assert.deepEqual(prepare({ PATH: path.join(root, 'bin') }).ripgrep, { found: rg, downloadAllowed: false });
  assert.deepEqual(prepare({ PATH: path.join(root, 'empty') }).ripgrep, { found: null, downloadAllowed: false });
  assert.deepEqual(prepare({}).ripgrep, { found: null, downloadAllowed: false });
});

test('only MITTRCRAFT_ALLOW_RIPGREP_DOWNLOAD=1 allows the download', () => {
  assert.equal(prepare({ MITTRCRAFT_ALLOW_RIPGREP_DOWNLOAD: '1' }).ripgrep.downloadAllowed, true);
  for (const value of ['', '0', 'true', 'yes', ' 1']) {
    assert.equal(prepare({ MITTRCRAFT_ALLOW_RIPGREP_DOWNLOAD: value }).ripgrep.downloadAllowed, false, JSON.stringify(value));
  }
});

test('only invocations that can start the server need rg', () => {
  for (const argv of [[], ['serve'], ['serve', '--foreground', '--port', '9'], ['--port', '9'], ['restart'], ['tunnel', 'start'], ['connect-url'], ['update'], ['unknown']]) {
    assert.equal(startsServer(argv), true, argv.join(' '));
  }
  for (const argv of [['--help'], ['-h'], ['serve', '--help'], ['--version'], ['-v'], ['stop'], ['status'], ['logs'], ['startup', 'install'], ['schedule', 'list'], ['session', 'list'], ['models'], ['projects'], ['control']]) {
    assert.equal(startsServer(argv), false, argv.join(' '));
  }
});

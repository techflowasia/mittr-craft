import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findRipgrep, pathExtOf, prepareCliEnvironment, searchPathOf, startsServer } from './cli-env.js';

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
  for (const argv of [[], ['serve'], ['serve', '--foreground', '--port', '9'], ['--port', '9'], ['-p', '9'], ['--host', '0.0.0.0'], ['--port=9', 'serve'], ['restart'], ['-p', '9', 'restart'], ['tunnel', 'start'], ['--port', '9', 'tunnel', 'start'], ['connect-url'], ['update'], ['unknown'], ['startup', 'enable'], ['--port', '9', 'startup', 'enable'], ['startup', 'enable', '--port', '9']]) {
    assert.equal(startsServer(argv), true, argv.join(' '));
  }
  for (const argv of [['--help'], ['-h'], ['serve', '--help'], ['--version'], ['-v'], ['stop'], ['status'], ['-p', '3000', 'stop'], ['--port', '9', 'status'], ['--host', 'example.test', 'status'], ['--port=9', 'status'], ['logs'], ['--lines', '5', 'logs'], ['startup'], ['startup', 'status'], ['startup', 'disable'], ['-p', '9', 'startup', 'disable'], ['schedule', 'list'], ['session', 'list'], ['models'], ['projects'], ['control'], ['tunnel'], ['tunnel', 'help'], ['tunnel', 'doctor'], ['tunnel', 'providers'], ['tunnel', 'status'], ['tunnel', 'stop'], ['tunnel', 'ready'], ['tunnel', 'profile', 'list'], ['tunnel', 'completion', 'bash'], ['--port', '9', 'tunnel', 'doctor'], ['help'], ['completion'], ['completion', 'bash']]) {
    assert.equal(startsServer(argv), false, argv.join(' '));
  }
});

test('on Windows rg is rg.exe or a PATHEXT entry on a Path key, and no execute bit is asked for', () => {
  const present = new Set(['C:\\tools\\rg.exe', 'D:\\bin\\rg.cmd']);
  const fake = {
    statSync: (file) => {
      if (!present.has(file)) throw new Error('ENOENT');
      return { isFile: () => true };
    },
  };
  assert.equal(findRipgrep('C:\\none;C:\\tools', { fs: fake, platform: 'win32' }), 'C:\\tools\\rg.exe');
  assert.equal(findRipgrep('C:\\none;;D:\\bin', { fs: fake, platform: 'win32', pathext: '.COM;.EXE;.CMD' }), 'D:\\bin\\rg.cmd');
  assert.equal(findRipgrep('D:\\bin', { fs: fake, platform: 'win32', pathext: '.COM;.EXE' }), null);
  assert.equal(findRipgrep('C:\\tools', { fs: fake, platform: 'linux' }), null);
});

test('on Windows the search path and PATHEXT come from the keys whatever their case', () => {
  assert.equal(searchPathOf({ Path: 'C:\\a' }, 'win32'), 'C:\\a');
  assert.equal(searchPathOf({ PATH: 'C:\\a' }, 'win32'), 'C:\\a');
  assert.equal(searchPathOf({ pAtH: 'C:\\a' }, 'win32'), 'C:\\a');
  assert.equal(searchPathOf({ Path: 'C:\\a' }, 'linux'), undefined);
  assert.equal(searchPathOf({ PATH: '/a' }, 'linux'), '/a');
  assert.equal(searchPathOf({}, 'win32'), undefined);
  assert.equal(pathExtOf({ PathExt: '.EXE;.BAT' }, 'win32'), '.EXE;.BAT');
  assert.equal(pathExtOf({ PathExt: '.EXE' }, 'linux'), undefined);
});

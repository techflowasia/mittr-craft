import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { engineImportsV1 } from './engine-import.js';

const tempDir = (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-engine-import-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const place = (dir, name, content) => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
  return file;
};

test('the bundled server never imports, however it is named', (t) => {
  const resourcesDir = tempDir(t);
  const entry = place(resourcesDir, 'opencode-server/serve.mjs', Buffer.from('7f454c46', 'hex'));
  const linked = path.join(tempDir(t), 'opencode');
  fs.symlinkSync(entry, linked);
  assert.equal(engineImportsV1({ env: {}, resourcesDir }), false);
  for (const OPENCODE_BINARY of [entry, linked]) {
    assert.equal(engineImportsV1({ env: { OPENCODE_BINARY }, resourcesDir }), false);
    assert.equal(engineImportsV1({ env: { OPENCODE_BINARY, OPENCHAMBER_BUNDLED_OPENCODE_SERVER_DIR: path.dirname(entry) } }), false);
  }
});

test('a standalone opencode build imports', (t) => {
  const dir = tempDir(t);
  for (const [name, magic] of [['elf', '7f454c46'], ['macho', 'cffaedfe'], ['universal', 'cafebabe'], ['windows.exe', '4d5a9000']]) {
    const OPENCODE_BINARY = place(dir, name, Buffer.concat([Buffer.from(magic, 'hex'), Buffer.alloc(64)]));
    assert.equal(engineImportsV1({ env: { OPENCODE_BINARY }, resourcesDir: dir }), true, name);
  }
});

test('an npm launcher of the opencode build imports, by its place or by what it runs', (t) => {
  const dir = tempDir(t);
  const launcher = place(dir, 'lib/node_modules/opencode-ai/bin/opencode', '#!/usr/bin/env node\n');
  const scoped = place(dir, 'lib/node_modules/@opencode/cli/bin/opencode', '#!/usr/bin/env node\n');
  const linked = path.join(dir, 'opencode');
  fs.symlinkSync(launcher, linked);
  const shim = place(dir, 'opencode.cmd', '@"%~dp0\\node_modules\\opencode-ai\\bin\\opencode" %*\r\n');
  for (const OPENCODE_BINARY of [launcher, scoped, linked, shim]) assert.equal(engineImportsV1({ env: { OPENCODE_BINARY } }), true, OPENCODE_BINARY);
});

test('anything else is unknown and counts as not importing', (t) => {
  const dir = tempDir(t);
  const script = place(dir, 'wrapper', '#!/bin/sh\nexec node /srv/engine.mjs "$@"\n');
  const empty = place(dir, 'empty', '');
  for (const OPENCODE_BINARY of ['', '  ', script, empty, dir, path.join(dir, 'missing'), undefined]) {
    assert.equal(engineImportsV1({ env: { OPENCODE_BINARY } }), false, String(OPENCODE_BINARY));
  }
});

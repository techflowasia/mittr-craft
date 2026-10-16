import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ensureLocalToken } from './local-token.js';
import { tempDataDir } from './test-helpers.js';

const TOKEN = /^mc_local_[0-9a-f]{64}$/;
const modeOf = (file) => fs.statSync(file).mode & 0o777;

test('a first call writes a new token, readable by its owner only', (t) => {
  const tokenPath = path.join(tempDataDir(t), 'nested', 'mittr-shim-token');
  const token = ensureLocalToken({ tokenPath });
  assert.match(token, TOKEN);
  assert.equal(fs.readFileSync(tokenPath, 'utf8'), token);
  assert.equal(modeOf(tokenPath), 0o600);
});

test('a valid token is kept', (t) => {
  const tokenPath = path.join(tempDataDir(t), 'mittr-shim-token');
  assert.equal(ensureLocalToken({ tokenPath }), ensureLocalToken({ tokenPath }));
});

test('a kept token that others could read is made private again', (t) => {
  const tokenPath = path.join(tempDataDir(t), 'mittr-shim-token');
  const token = ensureLocalToken({ tokenPath });
  fs.chmodSync(tokenPath, 0o644);
  assert.equal(ensureLocalToken({ tokenPath }), token);
  assert.equal(modeOf(tokenPath), 0o600);
});

test('anything that is not a token is replaced', (t) => {
  const tokenPath = path.join(tempDataDir(t), 'mittr-shim-token');
  for (const content of ['not-a-token', `mc_local_${'g'.repeat(64)}`, `mc_local_${'a'.repeat(63)}`, '']) {
    fs.writeFileSync(tokenPath, content, { mode: 0o644 });
    const token = ensureLocalToken({ tokenPath });
    assert.match(token, TOKEN);
    assert.notEqual(token, content);
    assert.equal(modeOf(tokenPath), 0o600);
  }
});

test('rotate writes a new token even when the old one is valid, and leaves no temporary file', (t) => {
  const dir = tempDataDir(t);
  const tokenPath = path.join(dir, 'mittr-shim-token');
  const first = ensureLocalToken({ tokenPath });
  const second = ensureLocalToken({ tokenPath, rotate: true });
  assert.match(second, TOKEN);
  assert.notEqual(second, first);
  assert.equal(fs.readFileSync(tokenPath, 'utf8'), second);
  assert.equal(modeOf(tokenPath), 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['mittr-shim-token']);
});

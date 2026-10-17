import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { repoRoot } from './upstream-contract.js';

const BIN = path.join(repoRoot, 'packages/mittr-server/bin/mittrcraft.mjs');
const SERVER_CLI = path.join(repoRoot, 'packages/web/bin/cli.js');

const runIsolated = (t, entry, args) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittrcraft-bin-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCHAMBER_|OPENCODE_|XDG_|MITTR)/.test(name)));
  const result = spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8',
    cwd: home,
    timeout: 60_000,
    env: {
      ...inherited,
      HOME: home,
      USERPROFILE: home,
      OPENCHAMBER_DATA_DIR: path.join(home, 'data'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      XDG_STATE_HOME: path.join(home, '.local', 'state'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      NO_COLOR: '1',
    },
  });
  return result;
};

test('the mittrcraft bin forwards to the server CLI', (t) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/mittr-server/package.json'), 'utf8'));
  assert.deepEqual(manifest.bin, { mittrcraft: './bin/mittrcraft.mjs' });
  assert.ok(fs.statSync(BIN).mode & 0o111, 'the bin is not executable');

  const wrapped = runIsolated(t, BIN, ['--help']);
  const direct = runIsolated(t, SERVER_CLI, ['--help']);

  assert.equal(wrapped.status, 0, wrapped.stderr);
  assert.equal(direct.status, 0, direct.stderr);
  assert.ok(wrapped.stdout.includes('openchamber [COMMAND] [OPTIONS]'), wrapped.stdout);
  assert.equal(wrapped.stdout, direct.stdout);
});

test('the mittrcraft bin hands every argument on unchanged', (t) => {
  const wrapped = runIsolated(t, BIN, ['--definitely-not-a-flag']);
  const direct = runIsolated(t, SERVER_CLI, ['--definitely-not-a-flag']);

  assert.notEqual(direct.status, 0);
  assert.equal(wrapped.status, direct.status);
  assert.equal(wrapped.stdout, direct.stdout);
  assert.equal(wrapped.stderr, direct.stderr);
});

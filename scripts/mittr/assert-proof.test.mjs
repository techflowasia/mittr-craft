import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { proofChecks } from './assert-proof.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assert-proof.mjs');

// The shape prove-session-carryover.mjs writes, trimmed to what the checks read.
const passingProof = () => ({
  before: [
    { file: 'opencode.db', v1: { session: 18, rootSession: 16 }, v2: { session_v2: null, v1NotInV2: null } },
    { file: 'opencode-.db', v1: { session: 0, rootSession: 0 }, v2: { session_v2: null, v1NotInV2: null } },
  ],
  migration: { file: 'opencode.db', state: { phase: 'completed' }, waitedMs: 518 },
  api: { listed: 18, distinct: 18 },
  after: [
    { file: 'opencode.db', v1: { session: 18, rootSession: 16 }, v2: { session_v2: 18, rootSession_v2: 16, v1NotInV2: 0 } },
    { file: 'opencode-.db', v1: { session: 0, rootSession: 0 }, v2: { session_v2: null, v1NotInV2: null } },
  ],
  roles: { unexplained: 0 },
});

const run = (t, ...proofs) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-proof-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = proofs.map((proof, index) => {
    const file = path.join(dir, `proof-${index}.json`);
    fs.writeFileSync(file, JSON.stringify(proof));
    return file;
  });
  return spawnSync(process.execPath, [script, ...files], { encoding: 'utf8' });
};

const failing = (proof) => proofChecks(proof).filter(({ pass }) => !pass).map(({ name }) => name);

test('a complete proof passes and the command exits 0', (t) => {
  assert.deepEqual(failing(passingProof()), []);
  const result = run(t, passingProof(), passingProof());
  assert.equal(result.status, 0, result.stdout);
  assert.doesNotMatch(result.stdout, /FAIL/);
});

test('a migration timeout fails', (t) => {
  const proof = passingProof();
  proof.migration = { file: 'opencode.db', state: { phase: 'running' }, waitedMs: 1800000, timedOut: true };
  assert.deepEqual(failing(proof), ['migration completed, no timeout']);
  assert.equal(run(t, passingProof(), proof).status, 1);
});

test('a 1.x session missing from session_v2 fails', (t) => {
  const proof = passingProof();
  proof.after[0].v2.v1NotInV2 = 1;
  assert.deepEqual(failing(proof), ['v1NotInV2 == 0']);
  assert.equal(run(t, proof).status, 1);
});

test('an API or table count below the count from before fails', (t) => {
  const api = passingProof();
  api.api = { listed: 18, distinct: 17 };
  assert.deepEqual(failing(api), ['API listed and distinct >= 1.x sessions']);
  assert.equal(run(t, api).status, 1);

  const table = passingProof();
  table.after[0].v2.session_v2 = 17;
  table.after[0].v2.rootSession_v2 = 15;
  assert.deepEqual(failing(table), ['session_v2 >= 1.x sessions', 'root session_v2 >= 1.x root sessions']);
  assert.equal(run(t, table).status, 1);
});

test('an error, a missing migration or unexplained roles fail, and so does an unreadable file', (t) => {
  const errored = passingProof();
  errored.error = 'engine exited during migration with code 1';
  delete errored.migration;
  assert.ok(failing(errored).includes('no error'));
  assert.ok(failing(errored).includes('the engine migrated a database'));

  const roles = passingProof();
  roles.roles.unexplained = 2;
  assert.deepEqual(failing(roles), ['roles unexplained == 0']);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-proof-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{');
  assert.equal(spawnSync(process.execPath, [script, path.join(dir, 'broken.json')]).status, 1);
  assert.equal(spawnSync(process.execPath, [script]).status, 1);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LEFT_OUT_FILE, leaveOutClosedEngineParts, verifyLeftOut } from './engine-left-out.mjs';

const server = (t, { chunks = {}, serve = 'import("./chunks/server-1.mjs")' } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-left-out-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'chunks'));
  fs.writeFileSync(path.join(dir, 'serve.mjs'), serve);
  for (const [name, text] of Object.entries({ 'agent-sdk-ab12.mjs': 'sdk', 'server-1.mjs': 'x=import("./agent-sdk-ab12.mjs").catch(()=>{});id="opencode.provider.some-agent"', ...chunks })) {
    if (text !== null) fs.writeFileSync(path.join(dir, 'chunks', name), text);
  }
  return dir;
};

test('the closed chunk is left out and its provider plugin is named', (t) => {
  const serverDir = server(t);
  assert.deepEqual(leaveOutClosedEngineParts({ serverDir }), { chunk: 'agent-sdk-ab12.mjs', plugins: ['opencode.provider.some-agent'] });
  assert.deepEqual(fs.readdirSync(path.join(serverDir, 'chunks')), ['server-1.mjs']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(serverDir, LEFT_OUT_FILE), 'utf8')), { plugins: ['opencode.provider.some-agent'] });
  assert.deepEqual(verifyLeftOut({ serverDir }), ['opencode.provider.some-agent']);
});

test('a build whose engine loads the chunk any other way stops', (t) => {
  for (const chunks of [
    { 'server-1.mjs': 'import "./agent-sdk-ab12.mjs";"opencode.provider.some-agent"' },
    { 'server-1.mjs': 'import("./agent-sdk-ab12.mjs");"opencode.provider.some-agent"' },
    { 'other-2.mjs': 'import("./agent-sdk-ab12.mjs").catch(()=>{})' },
  ]) {
    const serverDir = server(t, { chunks });
    assert.throws(() => leaveOutClosedEngineParts({ serverDir }), /only on demand/);
    assert.ok(fs.existsSync(path.join(serverDir, 'chunks', 'agent-sdk-ab12.mjs')));
  }
});

test('a build stops when the chunk or its plugin cannot be told', (t) => {
  assert.throws(() => leaveOutClosedEngineParts({ serverDir: server(t, { chunks: { 'agent-sdk-ab12.mjs': null } }) }), /found 0/);
  assert.throws(() => leaveOutClosedEngineParts({ serverDir: server(t, { chunks: { 'agent-sdk-cd34.mjs': 'two' } }) }), /found 2/);
  assert.throws(() => leaveOutClosedEngineParts({ serverDir: server(t, { chunks: { 'server-1.mjs': 'import("./agent-sdk-ab12.mjs").catch(()=>{})' } }) }), /provider plugin/);
});

test('a packed engine that still carries the chunk, or no list, fails the check', (t) => {
  const serverDir = server(t);
  assert.throws(() => verifyLeftOut({ serverDir }), /closed licence/);
  fs.rmSync(path.join(serverDir, 'chunks', 'agent-sdk-ab12.mjs'));
  assert.throws(() => verifyLeftOut({ serverDir }), /ENOENT/);
});

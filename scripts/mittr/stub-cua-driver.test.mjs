import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { STUB_PNG, answer } from './stub-cua-driver.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stub-cua-driver.mjs');

const run = (args) => new Promise((resolve) => {
  execFile(process.execPath, [SCRIPT, ...args], (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
});

const stateDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stub-cua-'));

test('list_apps answers Finder and MittrCraft Dev running and Calculator not running', () => {
  const { apps } = answer('list_apps', {}, { mode: 'normal' });
  assert.deepEqual(apps.map(({ name, running }) => [name, running]), [['Finder', true], ['MittrCraft Dev', true], ['Calculator', false]]);
});

test('get_desktop_state answers a fixed PNG, and the error mode answers the Screen Recording text', () => {
  const state = answer('get_desktop_state', {}, { mode: 'normal' });
  assert.equal(state.screenshot_mime_type, 'image/png');
  assert.deepEqual(Buffer.from(state.screenshot_png_b64, 'base64'), STUB_PNG);
  assert.deepEqual(STUB_PNG.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  assert.throws(() => answer('get_desktop_state', {}, { mode: 'screen-recording-error' }), /Screen Recording is NOT granted/);
});

test('the executable records each call with its arguments and prints JSON', async () => {
  const dir = stateDir();
  const listed = await run(['--state', dir, 'list_apps', '{}']);
  assert.equal(listed.code, 0);
  assert.equal(JSON.parse(listed.stdout).apps.length, 3);
  const front = await run(['--state', dir, 'bring_to_front', '{"pid":4243}']);
  assert.deepEqual(JSON.parse(front.stdout), { process_activated: true, exact_window_effect: { verified: true } });
  fs.writeFileSync(path.join(dir, 'mode'), 'screen-recording-error\n');
  const refused = await run(['--state', dir, 'get_desktop_state', '{}']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Screen Recording is NOT granted/);
  const calls = fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(calls.map(({ tool, args, mode }) => [tool, args, mode]), [
    ['list_apps', {}, 'normal'],
    ['bring_to_front', { pid: 4243 }, 'normal'],
    ['get_desktop_state', {}, 'screen-recording-error'],
  ]);
  const version = await run(['--version']);
  assert.equal(version.stdout.trim(), 'cua-driver 0.28.2-stub');
});

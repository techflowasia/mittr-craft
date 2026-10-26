import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SEVERAL_WINDOWS, STUB_PNG, answer } from './stub-cua-driver.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stub-cua-driver.mjs');

const run = (args) => new Promise((resolve) => {
  execFile(process.execPath, [SCRIPT, ...args], (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
});

const stateDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stub-cua-'));

test('list_apps answers Finder, MittrCraft Dev and the gate app running and Calculator not running', () => {
  const { apps } = answer('list_apps', {}, { mode: 'normal' });
  assert.deepEqual(apps.map(({ name, running }) => [name, running]), [['Finder', true], ['MittrCraft Dev', true], ['MittrCraft Gate', true], ['Calculator', false]]);
  assert.equal(apps.find(({ name }) => name === 'MittrCraft Gate').bundle_id, 'dev.mittrcraft.desktop.dev.gate');
});

test('get_desktop_state answers a fixed PNG, and the error mode answers the Screen Recording text', () => {
  const state = answer('get_desktop_state', {}, { mode: 'normal' });
  assert.equal(state.screenshot_mime_type, 'image/png');
  assert.deepEqual(Buffer.from(state.screenshot_png_b64, 'base64'), STUB_PNG);
  assert.deepEqual(STUB_PNG.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  assert.throws(() => answer('get_desktop_state', {}, { mode: 'screen-recording-error' }), /Screen Recording is NOT granted/);
});

test('the several-windows mode answers a pid-only bring_to_front as the real driver does for one titled and four untitled windows', () => {
  assert.deepEqual(answer('bring_to_front', { pid: 4243 }, { mode: 'several-windows' }), { code: 'ambiguous_window_target', candidates: SEVERAL_WINDOWS });
  assert.deepEqual(SEVERAL_WINDOWS.map(({ title }) => title), ['Calculator', '', '', '', '']);
  assert.deepEqual(answer('bring_to_front', { pid: 4243, window_id: 3965 }, { mode: 'several-windows' }), { process_activated: true, exact_window_effect: { verified: true } });
  assert.deepEqual(answer('bring_to_front', { pid: 4243 }, { mode: 'normal' }), { process_activated: true, exact_window_effect: { verified: true } });
});

test('the executable records each call with its arguments and prints JSON', async () => {
  const dir = stateDir();
  const listed = await run(['--state', dir, 'list_apps', '{}']);
  assert.equal(listed.code, 0);
  assert.equal(JSON.parse(listed.stdout).apps.length, 4);
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

test('the executable also runs as a daemon on the socket it is given and answers calls and a stop through it', async () => {
  const dir = stateDir();
  const socketPath = path.join(dir, 'd.sock');
  const quiet = { CUA_DRIVER_RS_TELEMETRY_ENABLED: '0', CUA_TELEMETRY_ENABLED: '0', CUA_DRIVER_RS_UPDATE_CHECK: '0', CUA_DRIVER_TELEMETRY_HOME: path.join(dir, 'cua'), HOME: dir };
  const daemon = execFile(process.execPath, [SCRIPT, '--state', dir, 'serve', '--socket', socketPath], { env: { PATH: process.env.PATH, ...quiet } });
  const exited = new Promise((resolve) => daemon.once('exit', resolve));
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(socketPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  const listed = await run(['--state', dir, 'call', 'list_apps', '{}', '--socket', socketPath]);
  assert.equal(listed.code, 0);
  assert.equal(JSON.parse(listed.stdout).apps.length, 4);
  fs.writeFileSync(path.join(dir, 'mode'), 'screen-recording-error\n');
  const refused = await run(['--state', dir, 'call', 'get_desktop_state', '{}', '--socket', socketPath]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Screen Recording is NOT granted/);
  assert.equal((await run(['--state', dir, 'stop', '--socket', socketPath])).code, 0);
  assert.equal(await exited, 0);
  const gone = await run(['--state', dir, 'call', 'list_apps', '{}', '--socket', socketPath]);
  assert.equal(gone.code, 1);
  assert.match(gone.stderr, new RegExp(`daemon is not running on ${socketPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const calls = fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((entry) => entry.daemon ?? entry.tool), ['serve', 'list_apps', 'get_desktop_state']);
  assert.deepEqual(calls[0].env, quiet);
});

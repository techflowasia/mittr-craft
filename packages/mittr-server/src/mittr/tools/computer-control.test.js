import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { SCREEN_RECORDING_NOT_GRANTED, stubCuaDriver, tempDataDir } from '../test-helpers.js';
import { OPEN_COMMAND, createComputerControl, createLaunchApp, resolveCuaDriver } from './computer-control.js';
import { MittrToolError } from './registry.js';

const fakeSpawn = (respond = () => ({})) => {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kills = [];
    child.kill = (signal) => {
      child.kills.push(signal);
      return true;
    };
    calls.push({ command, args, options, child });
    setImmediate(() => {
      const { stdout = '', stderr = '', code = 0, error } = respond({ command, args, options }) ?? {};
      if (error) {
        child.emit('error', error);
        return;
      }
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      if (code !== null) child.emit('close', code);
    });
    return child;
  };
  return { spawn, calls };
};

const packedDriver = (t) => {
  const resourcesDir = path.join(tempDataDir(t), 'Resources');
  fs.mkdirSync(path.join(resourcesDir, 'cua-driver'), { recursive: true });
  fs.writeFileSync(path.join(resourcesDir, 'cua-driver', 'cua-driver'), '');
  return resourcesDir;
};

test('the packed driver is found in the app resources when no driver folder is set', (t) => {
  const resourcesDir = packedDriver(t);
  assert.equal(resolveCuaDriver({ resourcesDir, env: {} }), path.join(resourcesDir, 'cua-driver', 'cua-driver'));
  assert.equal(resolveCuaDriver({ resourcesDir, env: { MITTRCRAFT_BUNDLED_CUA_DRIVER_DIR: '  ' } }), path.join(resourcesDir, 'cua-driver', 'cua-driver'));
  assert.equal(resolveCuaDriver({ resourcesDir: null, env: {} }), null);
  assert.equal(resolveCuaDriver({ resourcesDir: path.join(tempDataDir(t), 'Resources'), env: {} }), null);
});

test('a driver folder that is set is the only place looked at', (t) => {
  const resourcesDir = packedDriver(t);
  const envDir = tempDataDir(t);
  const env = { MITTRCRAFT_BUNDLED_CUA_DRIVER_DIR: envDir };

  assert.equal(resolveCuaDriver({ resourcesDir, env }), null, 'a missing driver in the set folder falls through to the packed copy');

  fs.writeFileSync(path.join(envDir, 'cua-driver'), '');
  assert.equal(resolveCuaDriver({ resourcesDir, env }), path.join(envDir, 'cua-driver'));
});

test('a driver tool runs the binary with the tool and its JSON arguments, without a shell', async () => {
  const { spawn, calls } = fakeSpawn(() => ({ stdout: '{"apps":[]}' }));
  const control = createComputerControl({ binary: '/r/cua-driver/cua-driver', spawn });
  assert.equal(control.available, true);

  assert.deepEqual(await control.request('bring_to_front', { pid: 42 }), { apps: [] });
  assert.deepEqual(await control.request('list_apps'), { apps: [] });

  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['/r/cua-driver/cua-driver', ['bring_to_front', '{"pid":42}']],
    ['/r/cua-driver/cua-driver', ['list_apps', '{}']],
  ]);
  for (const { options } of calls) {
    assert.notEqual(options.shell, true);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  }
});

test('a driver that exits with an error rejects with what it wrote, and one that answers no JSON says so', async () => {
  const failing = createComputerControl({ binary: '/d', spawn: fakeSpawn(() => ({ stderr: ` ${SCREEN_RECORDING_NOT_GRANTED}\n`, code: 1 })).spawn });
  await assert.rejects(failing.request('get_desktop_state'), { message: SCREEN_RECORDING_NOT_GRANTED });

  const silent = createComputerControl({ binary: '/d', spawn: fakeSpawn(() => ({ code: 3 })).spawn });
  await assert.rejects(silent.request('list_apps'), { message: 'cua-driver list_apps exited with code 3' });

  const garbled = createComputerControl({ binary: '/d', spawn: fakeSpawn(() => ({ stdout: `<${'x'.repeat(300)}` })).spawn });
  await assert.rejects(garbled.request('list_apps'), { message: `cua-driver list_apps did not return JSON: <${'x'.repeat(199)}` });

  const missing = createComputerControl({ binary: '/d', spawn: fakeSpawn(() => ({ error: Object.assign(new Error('spawn /d ENOENT'), { code: 'ENOENT' }) })).spawn });
  await assert.rejects(missing.request('list_apps'), { message: 'spawn /d ENOENT' });
});

test('an answer split across chunks is read whole, multi-byte names included', async () => {
  const body = Buffer.from(JSON.stringify({ apps: [{ name: 'ไฟล์' }] }));
  const spawn = (_command, _args, _options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit('data', body.subarray(0, 14));
      child.stdout.emit('data', body.subarray(14));
      child.emit('close', 0);
    });
    return child;
  };
  assert.deepEqual(await createComputerControl({ binary: '/d', spawn }).request('list_apps'), { apps: [{ name: 'ไฟล์' }] });
});

test('a driver that never answers is killed when its time is up', async () => {
  const { spawn, calls } = fakeSpawn(() => ({ code: null }));
  const control = createComputerControl({ binary: '/d', spawn, timeoutMs: 20 });
  await assert.rejects(control.request('get_desktop_state'), { message: 'cua-driver get_desktop_state timed out after 20ms' });
  assert.deepEqual(calls[0].child.kills, ['SIGKILL']);
});

test('no driver means the control is unavailable and runs nothing', async () => {
  const { spawn, calls } = fakeSpawn();
  const control = createComputerControl({ binary: null, spawn });
  assert.equal(control.available, false);
  await assert.rejects(control.request('list_apps'), (error) => error instanceof MittrToolError && error.statusCode === 503);
  assert.deepEqual(calls, []);
});

test('the turn\'s signal reaches the driver process', async () => {
  const { spawn, calls } = fakeSpawn(() => ({ stdout: '{}' }));
  const { signal } = new AbortController();
  await createComputerControl({ binary: '/d', spawn }).request('list_apps', {}, { signal });
  assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[0].options.killSignal, 'SIGKILL');
});

test('an aborted turn kills the running driver and rejects as cancelled', async (t) => {
  const children = [];
  const spawn = (...args) => {
    const child = childProcess.spawn(...args);
    children.push(child);
    return child;
  };
  const control = createComputerControl({ binary: stubCuaDriver(t), spawn });
  const controller = new AbortController();
  const pending = control.request('hang', {}, { signal: controller.signal });
  await new Promise((resolve) => children[0].once('spawn', resolve));
  const exited = new Promise((resolve) => children[0].once('exit', (code, signal) => resolve(signal)));

  controller.abort();

  await assert.rejects(pending, (error) => error instanceof MittrToolError && error.statusCode === 499 && error.message === 'cua-driver hang was cancelled');
  assert.equal(await exited, 'SIGKILL');
});

test('a turn aborted before the call starts no driver', async () => {
  const { spawn, calls } = fakeSpawn();
  await assert.rejects(createComputerControl({ binary: '/d', spawn }).request('list_apps', {}, { signal: AbortSignal.abort() }), { statusCode: 499 });
  assert.deepEqual(calls, []);
});

test('a stub driver answers its tools through the real process', async (t) => {
  const control = createComputerControl({ binary: stubCuaDriver(t, { list_apps: { apps: [{ name: 'Calculator', pid: 7 }] } }) });
  assert.deepEqual(await control.request('list_apps'), { apps: [{ name: 'Calculator', pid: 7 }] });
  await assert.rejects(control.request('get_desktop_state'), { message: SCREEN_RECORDING_NOT_GRANTED });
  await assert.rejects(control.request('garbled'), { message: 'cua-driver garbled did not return JSON: not json' });
});

test('open_app runs open -a without a shell', async () => {
  const { spawn, calls } = fakeSpawn();
  await createLaunchApp({ spawn })('Calculator');
  assert.equal(OPEN_COMMAND, '/usr/bin/open');
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [['/usr/bin/open', ['-a', 'Calculator']]]);
  assert.notEqual(calls[0].options.shell, true);
});

test('an app open cannot find rejects with what open wrote', async () => {
  const { spawn } = fakeSpawn(() => ({ stderr: 'Unable to find application named \'Nope\'\n', code: 1 }));
  await assert.rejects(createLaunchApp({ spawn })('Nope'), { message: 'Unable to find application named \'Nope\'' });
  const quiet = fakeSpawn(() => ({ code: 1 }));
  await assert.rejects(createLaunchApp({ spawn: quiet.spawn })('Nope'), { message: 'open -a "Nope" exited with code 1' });
});

test('opening an app carries the turn\'s signal and is killed when its time is up', async () => {
  const { signal } = new AbortController();
  const answered = fakeSpawn();
  await createLaunchApp({ spawn: answered.spawn })('Calculator', { signal });
  assert.equal(answered.calls[0].options.signal, signal);
  assert.equal(answered.calls[0].options.killSignal, 'SIGKILL');

  const stuck = fakeSpawn(() => ({ code: null }));
  await assert.rejects(createLaunchApp({ spawn: stuck.spawn, timeoutMs: 20 })('Calculator'), { message: 'open -a "Calculator" timed out after 20ms' });
  assert.deepEqual(stuck.calls[0].child.kills, ['SIGKILL']);
});

test('an aborted turn kills open and rejects as cancelled', async (t) => {
  const stub = stubCuaDriver(t);
  const children = [];
  const spawn = (_command, _args, options) => {
    const child = childProcess.spawn(stub, ['hang'], options);
    children.push(child);
    return child;
  };
  const controller = new AbortController();
  const pending = createLaunchApp({ spawn })('Calculator', { signal: controller.signal });
  await new Promise((resolve) => children[0].once('spawn', resolve));
  const exited = new Promise((resolve) => children[0].once('exit', (_code, signal) => resolve(signal)));

  controller.abort();

  await assert.rejects(pending, (error) => error instanceof MittrToolError && error.statusCode === 499 && error.message === 'open -a "Calculator" was cancelled');
  assert.equal(await exited, 'SIGKILL');
});

test('a turn aborted before opening runs nothing', async () => {
  const { spawn, calls } = fakeSpawn();
  await assert.rejects(createLaunchApp({ spawn })('Calculator', { signal: AbortSignal.abort() }), { statusCode: 499 });
  assert.deepEqual(calls, []);
});

test('a driver that answers more than the output cap is stopped and says so', async () => {
  const { spawn, calls } = fakeSpawn(({ args }) => (args[0] === 'small' ? { stdout: '{"a":1}' } : { stdout: 'x'.repeat(64), code: null }));
  const control = createComputerControl({ binary: '/d', spawn, maxOutputBytes: 32 });
  await assert.rejects(control.request('get_desktop_state'), { message: 'cua-driver get_desktop_state answered more than 32 bytes and was stopped' });
  assert.deepEqual(calls[0].child.kills, ['SIGKILL']);
  assert.deepEqual(await control.request('small'), { a: 1 });
});

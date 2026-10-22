import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { SCREEN_RECORDING_NOT_GRANTED, stubCuaDriver, stubCuaDriverCalls, tempDataDir, until } from '../test-helpers.js';
import {
  DRIVER_DOWN,
  DRIVER_STOPPED,
  MAX_SOCKET_PATH_BYTES,
  OPEN_COMMAND,
  QUIET_DRIVER_ENV,
  QUIT_STOP_COMMAND_TIMEOUT_MS,
  createComputerControl,
  createDriverDaemon,
  createLaunchApp,
  daemonLaunch,
  daemonPidFile,
  driverAppBundle,
  driverEnv,
  driverSocketPath,
  prepareDriverFolder,
  resolveCuaDriver,
} from './computer-control.js';
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
      if (child.exitOnKill) setImmediate(() => child.emit('close', null, signal));
      return true;
    };
    calls.push({ command, args, options, child });
    setImmediate(() => {
      const { stdout = '', stderr = '', code = 0, error, exitOnKill = false } = respond({ command, args, options }) ?? {};
      child.exitOnKill = exitOnKill;
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

const SOCKET = '/data/cua/d.sock';
const QUIET_ENV = { ...QUIET_DRIVER_ENV, CUA_DRIVER_TELEMETRY_HOME: '/data/cua' };

const fakeDaemon = ({ socketPath = SOCKET, ensure = async () => {}, restart = async () => true } = {}) => {
  const record = { ensured: 0, restarted: 0, stopped: 0, closed: 0 };
  const generation = { epoch: 0 };
  return {
    record,
    generation,
    usable: true,
    socketPath,
    env: QUIET_ENV,
    ensure: async () => {
      record.ensured += 1;
      await ensure();
      return generation;
    },
    restart: async (from) => {
      record.restarted += 1;
      assert.equal(from, generation);
      return (await restart()) ? generation : null;
    },
    stop: async () => {
      record.stopped += 1;
    },
    close: async () => {
      record.closed += 1;
    },
  };
};

const control = (options) => createComputerControl({ binary: '/d', daemon: fakeDaemon(), ...options });

const packedDriver = (t) => {
  const resourcesDir = path.join(tempDataDir(t), 'Resources');
  fs.mkdirSync(path.join(resourcesDir, 'cua-driver'), { recursive: true });
  fs.writeFileSync(path.join(resourcesDir, 'cua-driver', 'cua-driver'), '');
  return resourcesDir;
};

const realDaemon = (t, binary, options = {}) => {
  const dataDir = tempDataDir(t);
  const daemon = createDriverDaemon({ binary, dataDir, env: { PATH: process.env.PATH, HOME: dataDir }, probeIntervalMs: 10, ...options });
  t.after(() => daemon.stop());
  return { daemon, dataDir };
};

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const serves = (binary) => stubCuaDriverCalls(binary).filter(({ command }) => command === 'serve');

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

test('a driver tool is a call to MittrCraft\'s own daemon socket with the tool and its JSON arguments, without a shell', async () => {
  const { spawn, calls } = fakeSpawn(() => ({ stdout: '{"apps":[]}' }));
  const daemon = fakeDaemon();
  const computer = createComputerControl({ binary: '/r/cua-driver/cua-driver', spawn, daemon });
  assert.equal(computer.available, true);

  assert.deepEqual(await computer.request('bring_to_front', { pid: 42 }), { apps: [] });
  assert.deepEqual(await computer.request('list_apps'), { apps: [] });

  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['/r/cua-driver/cua-driver', ['call', 'bring_to_front', '{"pid":42}', '--socket', SOCKET]],
    ['/r/cua-driver/cua-driver', ['call', 'list_apps', '{}', '--socket', SOCKET]],
  ]);
  for (const { options } of calls) {
    assert.notEqual(options.shell, true);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.deepEqual(options.env, QUIET_ENV);
  }
  assert.equal(daemon.record.ensured, 2);
});

test('the driver env keeps only the plain process variables and always turns telemetry and the update check off', () => {
  const env = driverEnv({
    dataDir: '/data',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/person',
      TMPDIR: '/tmp/x',
      LANG: 'th_TH.UTF-8',
      LC_ALL: 'th_TH.UTF-8',
      CFFIXED_USER_HOME: '/tmp/gate',
      CUA_DRIVER_RS_TELEMETRY_ENABLED: '1',
      CUA_TELEMETRY_ENABLED: 'true',
      CUA_DRIVER_RS_UPDATE_CHECK: 'on',
      CUA_DRIVER_TELEMETRY_HOME: '/Users/person/.cua-driver',
      CUA_DRIVER_EMBEDDED: '1',
      CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS: '1',
      CUA_DRIVER_PERMISSION_MODE: 'unrestricted',
      MITTRCRAFT_TOOLS_TOKEN: 'secret',
      NODE_OPTIONS: '--require /x.js',
      HTTPS_PROXY: 'http://proxy.example.test',
      XDG_RUNTIME_DIR: '/run/x',
    },
  });
  assert.deepEqual(env, {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/person',
    TMPDIR: '/tmp/x',
    LANG: 'th_TH.UTF-8',
    LC_ALL: 'th_TH.UTF-8',
    CFFIXED_USER_HOME: '/tmp/gate',
    CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
    CUA_TELEMETRY_ENABLED: '0',
    CUA_DRIVER_RS_UPDATE_CHECK: '0',
    CUA_DRIVER_TELEMETRY_HOME: '/data/cua',
  });
});

test('the daemon socket lives in MittrCraft\'s data folder, and a data folder too long for a socket starts nothing', async (t) => {
  assert.equal(driverSocketPath('/Users/person/.config/mittrcraft-dev'), '/Users/person/.config/mittrcraft-dev/cua/d.sock');
  assert.ok(Buffer.byteLength(driverSocketPath('/Users/person/.config/mittrcraft-dev')) <= MAX_SOCKET_PATH_BYTES);

  const dataDir = tempDataDir(t);
  const fine = createDriverDaemon({ binary: '/d', dataDir });
  assert.equal(fine.socketPath, path.join(dataDir, 'cua', 'd.sock'));
  assert.equal(fine.env.CUA_DRIVER_TELEMETRY_HOME, path.join(dataDir, 'cua'));

  const long = `/${'a'.repeat(MAX_SOCKET_PATH_BYTES - '/cua/d.sock'.length)}`;
  assert.equal(Buffer.byteLength(driverSocketPath(long)), MAX_SOCKET_PATH_BYTES + 1);
  const { spawn, calls } = fakeSpawn();
  const probed = [];
  const tooLong = createDriverDaemon({ binary: '/d', dataDir: long, spawn, probe: async (socket) => { probed.push(socket); return false; }, prepareFolder: () => {} });
  assert.equal(tooLong.usable, false);
  assert.equal(tooLong.socketPath, null);
  await assert.rejects(tooLong.ensure(), (error) => error instanceof MittrToolError && error.statusCode === 503 && error.message === 'The Computer tool is not available in this install');
  const offered = createComputerControl({ binary: '/d', dataDir: long, spawn });
  assert.equal(offered.available, false);
  await assert.rejects(offered.request('list_apps'), (error) => error.statusCode === 503 && !error.message.includes(long));
  assert.deepEqual(calls, []);
  assert.deepEqual(probed, []);

  assert.equal(createDriverDaemon({ binary: '/d', dataDir: 'relative' }).usable, false);
  assert.equal(createComputerControl({ binary: '/d', dataDir: null }).available, false);
});

test('the packed CuaDriver.app is started through LaunchServices with telemetry off and its own socket; a bare driver is started directly', () => {
  const env = { HOME: '/Users/person', ...QUIET_ENV };
  assert.deepEqual(daemonLaunch({ binary: '/R/cua-driver/cua-driver', app: '/R/cua-driver/CuaDriver.app', socketPath: SOCKET, env }), {
    command: OPEN_COMMAND,
    args: [
      '-W', '-n', '-g', '-a', '/R/cua-driver/CuaDriver.app',
      '--env', 'HOME=/Users/person',
      '--env', 'CUA_DRIVER_RS_TELEMETRY_ENABLED=0',
      '--env', 'CUA_TELEMETRY_ENABLED=0',
      '--env', 'CUA_DRIVER_RS_UPDATE_CHECK=0',
      '--env', 'CUA_DRIVER_TELEMETRY_HOME=/data/cua',
      '--args', 'serve', '--socket', SOCKET,
    ],
  });
  assert.deepEqual(daemonLaunch({ binary: '/stub/cua-driver', app: null, socketPath: SOCKET, env }), { command: '/stub/cua-driver', args: ['serve', '--socket', SOCKET] });
});

test('the app bundle is found only behind a link into CuaDriver.app/Contents/MacOS', (t) => {
  const resources = fs.realpathSync(tempDataDir(t));
  const macos = path.join(resources, 'cua-driver', 'CuaDriver.app', 'Contents', 'MacOS');
  fs.mkdirSync(macos, { recursive: true });
  fs.writeFileSync(path.join(macos, 'cua-driver'), '');
  fs.symlinkSync('./CuaDriver.app/Contents/MacOS/cua-driver', path.join(resources, 'cua-driver', 'cua-driver'));
  assert.equal(driverAppBundle(path.join(resources, 'cua-driver', 'cua-driver')), path.join(resources, 'cua-driver', 'CuaDriver.app'));

  const other = path.join(resources, 'Other.app', 'Contents', 'MacOS');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'cua-driver'), '');
  assert.equal(driverAppBundle(path.join(other, 'cua-driver')), null);
  assert.equal(driverAppBundle(stubCuaDriver(t)), null);
  assert.equal(driverAppBundle(path.join(resources, 'missing')), null);
});

test('starting through LaunchServices waits on the socket, keeps the open process as the daemon handle, and stops through the socket', async (t) => {
  const dataDir = tempDataDir(t);
  const socketPath = driverSocketPath(dataDir);
  let listening = false;
  const probed = [];
  const { spawn, calls } = fakeSpawn(({ command, args }) => {
    if (command === OPEN_COMMAND) {
      setTimeout(() => { listening = true; }, 30);
      return { code: null, exitOnKill: true };
    }
    if (args[0] === 'stop') listening = false;
    return {};
  });
  const daemon = createDriverDaemon({
    binary: '/R/cua-driver/cua-driver',
    dataDir,
    env: { HOME: '/Users/person', CUA_DRIVER_RS_TELEMETRY_ENABLED: '1' },
    spawn,
    appBundle: () => '/R/cua-driver/CuaDriver.app',
    probe: async (socket) => { probed.push(socket); return listening; },
    readPid: () => null,
    probeIntervalMs: 5,
    stopTimeoutMs: 20,
  });

  await daemon.ensure();
  assert.equal(daemon.running(), true);
  assert.equal(fs.statSync(path.join(dataDir, 'cua')).mode & 0o777, 0o700);
  const [launcher] = calls;
  assert.equal(launcher.command, OPEN_COMMAND);
  assert.ok(launcher.args.includes('CUA_DRIVER_RS_TELEMETRY_ENABLED=0'));
  assert.ok(!launcher.args.includes('CUA_DRIVER_RS_TELEMETRY_ENABLED=1'));
  assert.deepEqual(launcher.args.slice(-3), ['serve', '--socket', socketPath]);
  assert.deepEqual(launcher.options.env, driverEnv({ env: { HOME: '/Users/person' }, dataDir }));

  await daemon.stop();
  assert.equal(daemon.running(), false);
  assert.deepEqual(calls.slice(1).map(({ command, args }) => [command, args]), [['/R/cua-driver/cua-driver', ['stop', '--socket', socketPath]]]);
  assert.deepEqual(launcher.child.kills, ['SIGKILL']);
  assert.deepEqual([...new Set(probed)], [socketPath]);
});

test('a daemon that never answers is killed when its time is up and the tool says the driver did not start', async (t) => {
  const dataDir = tempDataDir(t);
  const { spawn, calls } = fakeSpawn(({ args }) => (args[0] === 'serve' ? { code: null, exitOnKill: true } : {}));
  const daemon = createDriverDaemon({ binary: '/d', dataDir, spawn, probe: async () => false, appBundle: () => null, startTimeoutMs: 30, probeIntervalMs: 5 });
  await assert.rejects(daemon.ensure(), { message: `cua-driver serve did not answer on ${driverSocketPath(dataDir)} within 30ms` });
  assert.deepEqual(calls[0].child.kills, ['SIGKILL']);

  const computer = createComputerControl({ binary: '/d', daemon, spawn });
  await assert.rejects(computer.request('list_apps'), (error) => error instanceof MittrToolError && error.statusCode === 503 && error.message === DRIVER_DOWN);
  assert.equal(calls.filter(({ args }) => args[0] === 'call').length, 0);
});

test('a daemon that exits before it answers rejects with what it wrote', async (t) => {
  const { spawn } = fakeSpawn(() => ({ stderr: 'LSOpenURLsWithRole() failed\n', code: 1 }));
  const daemon = createDriverDaemon({ binary: '/d', dataDir: tempDataDir(t), spawn, probe: async () => false, appBundle: () => null, probeIntervalMs: 5 });
  await assert.rejects(daemon.ensure(), { message: 'LSOpenURLsWithRole() failed' });
  assert.equal(daemon.running(), false);
});

test('a driver that exits with an error rejects with what it wrote, and one that answers no JSON says so', async () => {
  const failing = control({ spawn: fakeSpawn(() => ({ stderr: ` ${SCREEN_RECORDING_NOT_GRANTED}\n`, code: 1 })).spawn });
  await assert.rejects(failing.request('get_desktop_state'), { message: SCREEN_RECORDING_NOT_GRANTED });

  const silent = control({ spawn: fakeSpawn(() => ({ code: 3 })).spawn });
  await assert.rejects(silent.request('list_apps'), { message: 'cua-driver list_apps exited with code 3' });

  const garbled = control({ spawn: fakeSpawn(() => ({ stdout: `<${'x'.repeat(300)}` })).spawn });
  await assert.rejects(garbled.request('list_apps'), { message: `cua-driver list_apps did not return JSON: <${'x'.repeat(199)}` });

  const missing = control({ spawn: fakeSpawn(() => ({ error: Object.assign(new Error('spawn /d ENOENT'), { code: 'ENOENT' }) })).spawn });
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
  assert.deepEqual(await control({ spawn }).request('list_apps'), { apps: [{ name: 'ไฟล์' }] });
});

test('a driver that never answers is killed when its time is up', async () => {
  const { spawn, calls } = fakeSpawn(() => ({ code: null }));
  await assert.rejects(control({ spawn, timeoutMs: 20 }).request('get_desktop_state'), { message: 'cua-driver get_desktop_state timed out after 20ms' });
  assert.deepEqual(calls[0].child.kills, ['SIGKILL']);
});

test('no driver means the control is unavailable and runs nothing', async () => {
  const { spawn, calls } = fakeSpawn();
  const computer = createComputerControl({ binary: null, spawn, dataDir: '/data' });
  assert.equal(computer.available, false);
  await assert.rejects(computer.request('list_apps'), (error) => error instanceof MittrToolError && error.statusCode === 503);
  assert.deepEqual(calls, []);
});

test('the turn\'s signal reaches the driver process', async () => {
  const { spawn, calls } = fakeSpawn(() => ({ stdout: '{}' }));
  const { signal } = new AbortController();
  await control({ spawn }).request('list_apps', {}, { signal });
  assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[0].options.killSignal, 'SIGKILL');
});

test('an aborted turn kills the running driver call and rejects as cancelled', async (t) => {
  const children = [];
  let spawned;
  const running = new Promise((resolve) => { spawned = resolve; });
  const spawn = (...args) => {
    const child = childProcess.spawn(...args);
    children.push(child);
    child.once('spawn', spawned);
    return child;
  };
  const computer = control({ binary: stubCuaDriver(t), spawn });
  const controller = new AbortController();
  const pending = computer.request('hang', {}, { signal: controller.signal });
  await running;
  const exited = new Promise((resolve) => children[0].once('exit', (code, signal) => resolve(signal)));

  controller.abort();

  await assert.rejects(pending, (error) => error instanceof MittrToolError && error.statusCode === 499 && error.message === 'cua-driver hang was cancelled');
  assert.equal(await exited, 'SIGKILL');
});

test('a turn aborted while the daemon starts rejects as cancelled, and one aborted before the call starts nothing', async () => {
  const { spawn, calls } = fakeSpawn();
  await assert.rejects(control({ spawn }).request('list_apps', {}, { signal: AbortSignal.abort() }), { statusCode: 499 });
  assert.deepEqual(calls, []);

  const controller = new AbortController();
  const slow = fakeDaemon({ ensure: () => new Promise((resolve) => { setTimeout(resolve, 50); }) });
  const pending = createComputerControl({ binary: '/d', spawn, daemon: slow }).request('list_apps', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof MittrToolError && error.statusCode === 499);
  assert.deepEqual(calls, []);
});

test('a stub daemon is started once, answers every tool through its socket, and is reused', async (t) => {
  const binary = stubCuaDriver(t, { list_apps: { apps: [{ name: 'Calculator', pid: 7 }] } });
  const { daemon, dataDir } = realDaemon(t, binary);
  const computer = createComputerControl({ binary, daemon });

  const [first, second] = await Promise.all([computer.request('list_apps'), computer.request('list_apps')]);
  assert.deepEqual(first, { apps: [{ name: 'Calculator', pid: 7 }] });
  assert.deepEqual(second, first);
  assert.deepEqual(await computer.request('list_apps'), first);
  await assert.rejects(computer.request('get_desktop_state'), { message: SCREEN_RECORDING_NOT_GRANTED });
  await assert.rejects(computer.request('garbled'), { message: 'cua-driver garbled did not return JSON: not json' });

  const calls = stubCuaDriverCalls(binary);
  assert.equal(serves(binary).length, 1);
  const socketPath = path.join(dataDir, 'cua', 'd.sock');
  assert.deepEqual([...new Set(calls.map((entry) => entry.socketPath))], [socketPath]);
  for (const entry of calls) {
    assert.equal(entry.env.CUA_DRIVER_RS_TELEMETRY_ENABLED, '0');
    assert.equal(entry.env.CUA_TELEMETRY_ENABLED, '0');
    assert.equal(entry.env.CUA_DRIVER_RS_UPDATE_CHECK, '0');
    assert.equal(entry.env.CUA_DRIVER_TELEMETRY_HOME, path.join(dataDir, 'cua'));
  }
});

test('a dead daemon is started again once and the call goes through; when it cannot start again the tool says so plainly', async (t) => {
  const binary = stubCuaDriver(t, { list_apps: { apps: [] } });
  const { daemon } = realDaemon(t, binary);
  const computer = createComputerControl({ binary, daemon });
  assert.deepEqual(await computer.request('list_apps'), { apps: [] });
  const [{ pid }] = serves(binary);

  process.kill(pid, 'SIGKILL');
  await until(() => !isAlive(pid));
  assert.deepEqual(await computer.request('list_apps'), { apps: [] });
  assert.equal(serves(binary).length, 2);

  fs.writeFileSync(path.join(path.dirname(binary), 'serve-fails'), '');
  process.kill(serves(binary)[1].pid, 'SIGKILL');
  await until(() => !daemon.running());
  await assert.rejects(computer.request('list_apps'), (error) => error instanceof MittrToolError && error.statusCode === 503 && error.message === DRIVER_DOWN);
  assert.equal(serves(binary).length, 3);
});

test('a call that finds MittrCraft\'s daemon gone restarts it once and is sent again; twice gone says so plainly', async () => {
  const gone = `Cua Driver daemon is not running on ${SOCKET}.\nStart it first with: cua-driver serve --socket ${SOCKET}`;
  const answers = [{ stderr: gone, code: 1 }, { stdout: '{"apps":[]}' }];
  const once = fakeSpawn(() => answers.shift());
  const daemon = fakeDaemon();
  assert.deepEqual(await createComputerControl({ binary: '/d', spawn: once.spawn, daemon }).request('list_apps'), { apps: [] });
  assert.equal(daemon.record.restarted, 1);
  assert.equal(once.calls.length, 2);

  const twice = fakeSpawn(() => ({ stderr: gone, code: 1 }));
  const down = fakeDaemon();
  await assert.rejects(createComputerControl({ binary: '/d', spawn: twice.spawn, daemon: down }).request('list_apps'), (error) => error instanceof MittrToolError && error.statusCode === 503 && error.message === DRIVER_DOWN);
  assert.equal(down.record.restarted, 1);
  assert.equal(twice.calls.length, 2);

  const other = fakeSpawn(() => ({ stderr: 'Cua Driver daemon is not running on /Users/person/Library/Caches/cua-driver/cua-driver.sock.', code: 1 }));
  const untouched = fakeDaemon();
  await assert.rejects(createComputerControl({ binary: '/d', spawn: other.spawn, daemon: untouched }).request('list_apps'), { message: 'Cua Driver daemon is not running on /Users/person/Library/Caches/cua-driver/cua-driver.sock.' });
  assert.equal(untouched.record.restarted, 0);
  assert.equal(other.calls.length, 1);
});

test('stopping the stub daemon shuts it down through its own socket and a later call starts a fresh one', async (t) => {
  const binary = stubCuaDriver(t, { list_apps: { apps: [] } });
  const { daemon, dataDir } = realDaemon(t, binary);
  const computer = createComputerControl({ binary, daemon });
  await computer.request('list_apps');
  const [{ pid }] = serves(binary);

  await computer.stop();
  await until(() => !isAlive(pid));
  assert.equal(daemon.running(), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'cua', 'd.sock')), false);
  assert.deepEqual(stubCuaDriverCalls(binary).filter(({ command }) => command === 'stop').map(({ socketPath }) => socketPath), [path.join(dataDir, 'cua', 'd.sock')]);
  await computer.stop();

  await computer.request('list_apps');
  assert.equal(serves(binary).length, 2);
});

test('a daemon left on MittrCraft\'s socket by an earlier run is stopped before a fresh one starts', async (t) => {
  const binary = stubCuaDriver(t, { list_apps: { apps: [] } });
  const { daemon: earlier, dataDir } = realDaemon(t, binary);
  await earlier.ensure();
  const [{ pid }] = serves(binary);

  const later = createDriverDaemon({ binary, dataDir, env: { PATH: process.env.PATH, HOME: dataDir }, probeIntervalMs: 10 });
  t.after(() => later.stop());
  await later.ensure();
  await until(() => !isAlive(pid));
  assert.equal(serves(binary).length, 2);
  assert.equal(stubCuaDriverCalls(binary).filter(({ command }) => command === 'stop').length, 1);
});

const recordingLogger = () => {
  const lines = [];
  return { lines, warn: (...args) => lines.push(args.join(' ')) };
};

const callLogged = (binary) => until(() => stubCuaDriverCalls(binary).some(({ command }) => command === 'call'), 5000);

test('a call in flight while the Computer switch stops the daemon starts no new daemon', async (t) => {
  const binary = stubCuaDriver(t, { list_apps: { apps: [] } });
  const { daemon } = realDaemon(t, binary);
  await daemon.ensure();
  const [{ pid }] = serves(binary);
  fs.writeFileSync(path.join(path.dirname(binary), 'call-delay'), '400');
  const computer = createComputerControl({ binary, daemon });

  const pending = computer.request('list_apps');
  await callLogged(binary);
  await computer.stop();

  await assert.rejects(pending, (error) => error instanceof MittrToolError && error.statusCode === 503 && error.message === DRIVER_STOPPED);
  assert.equal(daemon.running(), false);
  assert.equal(isAlive(pid), false);
  assert.equal(serves(binary).length, 1);
});

test('a call in flight across dispose starts no new daemon, and nothing starts one after it', async (t) => {
  const binary = stubCuaDriver(t, { list_apps: { apps: [] } });
  const { daemon } = realDaemon(t, binary);
  await daemon.ensure();
  fs.writeFileSync(path.join(path.dirname(binary), 'call-delay'), '400');
  const computer = createComputerControl({ binary, daemon });

  const pending = computer.request('list_apps');
  await callLogged(binary);
  await computer.close();

  await assert.rejects(pending, (error) => error instanceof MittrToolError && error.statusCode === 503);
  await assert.rejects(computer.request('list_apps'), (error) => error instanceof MittrToolError && error.statusCode === 503 && error.message === 'MittrCraft is closing, so the Computer tool is not running');
  await assert.rejects(daemon.ensure(), { statusCode: 503 });
  assert.equal(daemon.running(), false);
  assert.equal(serves(binary).length, 1);
});

test('a late "gone" answer for an old daemon never stops the newer one, and none restarts after a stop', async (t) => {
  const binary = stubCuaDriver(t, { list_apps: { apps: [] } });
  const { daemon } = realDaemon(t, binary);
  const first = await daemon.ensure();
  const [{ pid: firstPid }] = serves(binary);
  process.kill(firstPid, 'SIGKILL');
  await until(() => !daemon.running());
  const second = await daemon.ensure();
  assert.notEqual(second, first);
  const secondPid = serves(binary)[1].pid;

  assert.equal(await daemon.restart(first), second);
  assert.equal(isAlive(secondPid), true);
  assert.equal(daemon.running(), true);
  assert.equal(serves(binary).length, 2);

  await daemon.stop();
  assert.equal(await daemon.restart(second), null);
  assert.equal(serves(binary).length, 2);
});

test('a LaunchServices daemon that does not stop through its socket is stopped by its pid file, only when that pid serves our socket', async (t) => {
  const run = async (command) => {
    const dataDir = tempDataDir(t);
    const socketPath = driverSocketPath(dataDir);
    let listening = false;
    const signals = [];
    const read = [];
    const logger = recordingLogger();
    const { spawn, calls } = fakeSpawn(({ command: spawned, args }) => {
      if (spawned === OPEN_COMMAND) {
        setTimeout(() => { listening = true; }, 10);
        return { code: null, exitOnKill: true };
      }
      if (args[0] === 'stop') return { stderr: 'stop failed', code: 1 };
      return {};
    });
    const daemon = createDriverDaemon({
      binary: '/R/cua-driver/cua-driver',
      dataDir,
      env: { HOME: '/Users/person' },
      spawn,
      appBundle: () => '/R/cua-driver/CuaDriver.app',
      probe: async () => listening,
      readPid: (file) => { read.push(file); return 4242; },
      commandOf: async (pid) => (pid === 4242 ? command(socketPath) : null),
      signalPid: (pid, signal) => signals.push([pid, signal]),
      isAlive: () => signals.length === 0,
      logger,
      probeIntervalMs: 5,
      stopTimeoutMs: 20,
    });
    await daemon.ensure();
    await daemon.stop();
    return { signals, read, logger, launcher: calls[0] };
  };

  const ours = await run((socketPath) => `/R/cua-driver/CuaDriver.app/Contents/MacOS/cua-driver serve --socket ${socketPath}`);
  assert.deepEqual(ours.read, [daemonPidFile('/Users/person')]);
  assert.equal(daemonPidFile('/Users/person'), '/Users/person/Library/Caches/cua-driver/cua-driver.pid');
  assert.deepEqual(ours.signals, [[4242, 'SIGTERM']]);
  assert.deepEqual(ours.logger.lines, ['[mittr] cua-driver did not stop through its socket; stopping it by its pid file']);
  assert.deepEqual(ours.launcher.child.kills, ['SIGKILL']);

  const someoneElse = await run(() => '/Applications/CuaDriver.app/Contents/MacOS/cua-driver serve');
  assert.deepEqual(someoneElse.signals, []);
  const otherSocket = await run(() => '/R/cua-driver/CuaDriver.app/Contents/MacOS/cua-driver serve --socket /Users/person/Library/Caches/cua-driver/cua-driver.sock');
  assert.deepEqual(otherSocket.signals, []);
});

test('an action token from before a stop starts nothing, even on a fresh control call', async (t) => {
  const binary = stubCuaDriver(t, { list_apps: { apps: [] } });
  const { daemon } = realDaemon(t, binary);
  const computer = createComputerControl({ binary, daemon });
  const token = computer.token();
  assert.deepEqual(await computer.request('list_apps', {}, { token }), { apps: [] });
  await computer.stop();
  await assert.rejects(computer.request('list_apps', {}, { token }), (error) => error instanceof MittrToolError && error.statusCode === 503 && error.message === DRIVER_STOPPED);
  assert.equal(serves(binary).length, 1);
  assert.deepEqual(await computer.request('list_apps', {}, { token: computer.token() }), { apps: [] });
  assert.equal(serves(binary).length, 2);
});

test('a stop during a start ends the wait at once and halts what was spawned', async (t) => {
  const dataDir = tempDataDir(t);
  const { spawn, calls } = fakeSpawn(({ args }) => (args[0] === 'serve' ? { code: null, exitOnKill: true } : {}));
  const daemon = createDriverDaemon({ binary: '/d', dataDir, spawn, probe: async () => false, appBundle: () => null, startTimeoutMs: 5_000, probeIntervalMs: 1_000, stopTimeoutMs: 50 });
  const began = Date.now();
  const starting = daemon.ensure();
  await until(() => calls.length === 1);
  await daemon.stop();
  await assert.rejects(starting, (error) => error instanceof MittrToolError && error.message === DRIVER_STOPPED);
  assert.ok(Date.now() - began < 1_000, `took ${Date.now() - began}ms`);
  assert.deepEqual(calls[0].child.kills, ['SIGKILL']);
  assert.equal(daemon.running(), false);

  const beforeSpawn = { spawned: 0 };
  let stopNow;
  const early = createDriverDaemon({
    binary: '/d',
    dataDir: tempDataDir(t),
    spawn: (...args) => { beforeSpawn.spawned += 1; return fakeSpawn().spawn(...args); },
    probe: async () => false,
    appBundle: () => null,
    prepareFolder: () => { stopNow = early.stop(); },
  });
  await assert.rejects(early.ensure(), { message: DRIVER_STOPPED });
  await stopNow;
  assert.equal(beforeSpawn.spawned, 0);
});

test('the pid fallback checks the command again right before SIGKILL', async (t) => {
  const run = async (commands) => {
    const dataDir = tempDataDir(t);
    const socketPath = driverSocketPath(dataDir);
    const expected = `/R/cua-driver/CuaDriver.app/Contents/MacOS/cua-driver serve --socket ${socketPath}`;
    let listening = false;
    const signals = [];
    let asked = 0;
    const { spawn } = fakeSpawn(({ command }) => {
      if (command === OPEN_COMMAND) {
        setTimeout(() => { listening = true; }, 10);
        return { code: null, exitOnKill: true };
      }
      return { code: 1 };
    });
    const daemon = createDriverDaemon({
      binary: '/R/cua-driver/cua-driver',
      dataDir,
      env: { HOME: '/Users/person' },
      spawn,
      appBundle: () => '/R/cua-driver/CuaDriver.app',
      probe: async () => listening,
      readPid: () => 4242,
      commandOf: async () => {
        const answer = commands[Math.min(asked, commands.length - 1)];
        asked += 1;
        return answer === 'ours' ? expected : answer;
      },
      signalPid: (pid, signal) => signals.push(signal),
      isAlive: () => true,
      probeIntervalMs: 5,
      stopTimeoutMs: 20,
    });
    await daemon.ensure();
    await daemon.stop();
    return signals;
  };
  assert.deepEqual(await run(['ours', 'ours']), ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(await run(['ours', '/usr/bin/some-new-process']), ['SIGTERM']);
});

test('at quit a stop that hangs on the socket gives up early, so the pid fallback still runs inside the 3 s cap', async (t) => {
  const dataDir = tempDataDir(t);
  const socketPath = driverSocketPath(dataDir);
  let listening = false;
  const signals = [];
  const { spawn, calls } = fakeSpawn(({ command, args }) => {
    if (command === OPEN_COMMAND) {
      setTimeout(() => { listening = true; }, 10);
      return { code: null, exitOnKill: true };
    }
    return args[0] === 'stop' ? { code: null, exitOnKill: true } : {};
  });
  const daemon = createDriverDaemon({
    binary: '/R/cua-driver/cua-driver',
    dataDir,
    env: { HOME: '/Users/person' },
    spawn,
    appBundle: () => '/R/cua-driver/CuaDriver.app',
    probe: async () => listening,
    readPid: () => 4242,
    commandOf: async () => `/R/cua-driver/CuaDriver.app/Contents/MacOS/cua-driver serve --socket ${socketPath}`,
    signalPid: (pid, signal) => signals.push(signal),
    isAlive: () => signals.length === 0,
    probeIntervalMs: 5,
  });
  await daemon.ensure();
  const began = Date.now();
  await daemon.close();
  const took = Date.now() - began;
  assert.ok(QUIT_STOP_COMMAND_TIMEOUT_MS < 3_000);
  assert.ok(took >= QUIT_STOP_COMMAND_TIMEOUT_MS && took < 3_000, `took ${took}ms`);
  assert.deepEqual(signals, ['SIGTERM']);
  const stopCall = calls.find(({ args }) => args[0] === 'stop');
  assert.deepEqual(stopCall.child.kills, ['SIGKILL']);
});

test('a daemon that did not start is logged with its reason, and the agent sees only the plain sentence', async (t) => {
  const logger = recordingLogger();
  const { spawn } = fakeSpawn(() => ({ stderr: 'LSOpenURLsWithRole() failed\n', code: 1 }));
  const daemon = createDriverDaemon({ binary: '/d', dataDir: tempDataDir(t), spawn, probe: async () => false, appBundle: () => null, probeIntervalMs: 5 });
  const computer = createComputerControl({ binary: '/d', daemon, spawn, logger });
  await assert.rejects(computer.request('list_apps'), (error) => error instanceof MittrToolError && error.message === DRIVER_DOWN);
  assert.deepEqual(logger.lines, ['[mittr] the Computer tool\'s desktop driver is not running: LSOpenURLsWithRole() failed']);
});

test('the driver folder must be a plain folder of this user and is made private every time', (t) => {
  const root = tempDataDir(t);
  const fresh = path.join(root, 'fresh', 'cua');
  prepareDriverFolder(fresh);
  assert.equal(fs.statSync(fresh).mode & 0o777, 0o700);

  const open = path.join(root, 'open');
  fs.mkdirSync(open, { mode: 0o755 });
  fs.chmodSync(open, 0o755);
  prepareDriverFolder(open);
  assert.equal(fs.statSync(open).mode & 0o777, 0o700);

  const target = path.join(root, 'target');
  fs.mkdirSync(target, { mode: 0o755 });
  const link = path.join(root, 'link');
  fs.symlinkSync(target, link);
  const refusal = (error) => error instanceof MittrToolError && error.statusCode === 503 && error.message === 'The Computer tool cannot use its driver folder because it is not a plain folder owned by this user';
  assert.throws(() => prepareDriverFolder(link), refusal);
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);

  const file = path.join(root, 'file');
  fs.writeFileSync(file, '');
  assert.throws(() => prepareDriverFolder(file), refusal);
});

test('a symlinked data folder still lets a "gone" answer naming the real path restart the daemon once', async (t) => {
  const real = fs.realpathSync(tempDataDir(t));
  const link = path.join(tempDataDir(t), 'link');
  fs.symlinkSync(real, link);
  fs.mkdirSync(path.join(real, 'cua'));
  const socketPath = driverSocketPath(link);
  assert.notEqual(fs.realpathSync(path.dirname(socketPath)), path.dirname(socketPath));
  const gone = `Cua Driver daemon is not running on ${path.join(real, 'cua', 'd.sock')}.\nStart it first with: cua-driver serve --socket ${path.join(real, 'cua', 'd.sock')}`;
  const answers = [{ stderr: gone, code: 1 }, { stdout: '{"apps":[]}' }];
  const { spawn } = fakeSpawn(() => answers.shift());
  const daemon = fakeDaemon({ socketPath });
  assert.deepEqual(await createComputerControl({ binary: '/d', spawn, daemon }).request('list_apps'), { apps: [] });
  assert.equal(daemon.record.restarted, 1);
});

test('opening an app gives it only the plain process variables, never the server\'s tokens or proxies', async () => {
  const { spawn, calls } = fakeSpawn();
  await createLaunchApp({
    spawn,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/person',
      TMPDIR: '/tmp/x',
      LANG: 'th_TH.UTF-8',
      LC_ALL: 'th_TH.UTF-8',
      MITTRCRAFT_TOOLS_TOKEN: 'secret',
      OPENCODE_SERVER_PASSWORD: 'secret',
      OPENCHAMBER_AGENT_TOOL_TOKEN: 'secret',
      HTTPS_PROXY: 'http://proxy.example.test',
      NODE_OPTIONS: '--require /x.js',
    },
  })('Calculator');
  assert.deepEqual(calls[0].options.env, { PATH: '/usr/bin:/bin', HOME: '/Users/person', TMPDIR: '/tmp/x', LANG: 'th_TH.UTF-8', LC_ALL: 'th_TH.UTF-8' });
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
  const { spawn, calls } = fakeSpawn(({ args }) => (args[1] === 'small' ? { stdout: '{"a":1}' } : { stdout: 'x'.repeat(64), code: null }));
  const computer = control({ spawn, maxOutputBytes: 32 });
  await assert.rejects(computer.request('get_desktop_state'), { message: 'cua-driver get_desktop_state answered more than 32 bytes and was stopped' });
  assert.deepEqual(calls[0].child.kills, ['SIGKILL']);
  assert.deepEqual(await computer.request('small'), { a: 1 });
});

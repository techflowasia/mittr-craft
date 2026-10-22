import { spawn as spawnChild } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { isText } from '../values.js';
import { MittrToolError } from './registry.js';

const CUA_DRIVER = 'cua-driver';
const CUA_APP = 'CuaDriver.app';
export const OPEN_COMMAND = '/usr/bin/open';
const CHILD_TIMEOUT_MS = 15_000;
const DAEMON_START_TIMEOUT_MS = 10_000;
const DAEMON_STOP_TIMEOUT_MS = 3_000;
const PROBE_INTERVAL_MS = 100;
const PROBE_TIMEOUT_MS = 500;
const MAX_LAUNCHER_STDERR_BYTES = 16 * 1024;

export const DRIVER_FOLDER = 'cua';
const SOCKET_NAME = 'd.sock';
export const MAX_SOCKET_PATH_BYTES = 103;

const NOT_BUNDLED = 'Computer use is not bundled in this build of MittrCraft';
export const DRIVER_DOWN = 'The Computer tool could not start its desktop driver. Try again, or turn the Computer tool off and on in Settings → Integrations.';
const CANCELLED = 499;

export const QUIET_DRIVER_ENV = Object.freeze({
  CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
  CUA_TELEMETRY_ENABLED: '0',
  CUA_DRIVER_RS_UPDATE_CHECK: '0',
});

const PASSED_ENV = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'CFFIXED_USER_HOME']);

export const bundledDriverPath = ({ dirFromEnv, resourcesDir, name, exists = fs.existsSync }) => {
  const fromEnv = String(dirFromEnv ?? '').trim();
  const fromResources = resourcesDir ? path.join(resourcesDir, name, name) : null;
  const candidate = fromEnv ? path.join(fromEnv, name) : fromResources;
  return candidate !== null && exists(candidate) ? candidate : null;
};

export const resolveCuaDriver = ({ resourcesDir, env, exists }) => bundledDriverPath({
  dirFromEnv: env.MITTRCRAFT_BUNDLED_CUA_DRIVER_DIR,
  resourcesDir,
  name: CUA_DRIVER,
  exists,
});

export const driverFolder = (dataDir) => path.join(dataDir, DRIVER_FOLDER);

export const driverSocketPath = (dataDir) => path.join(driverFolder(dataDir), SOCKET_NAME);

export const driverEnv = ({ env, dataDir }) => ({
  ...Object.fromEntries(Object.entries(env ?? {}).filter(([key, value]) => isText(value) && (PASSED_ENV.has(key) || key.startsWith('LC_')))),
  ...QUIET_DRIVER_ENV,
  CUA_DRIVER_TELEMETRY_HOME: driverFolder(dataDir),
});

export const driverAppBundle = (binary, realpath = fs.realpathSync) => {
  let real;
  try {
    real = realpath(binary);
  } catch {
    return null;
  }
  const macos = path.dirname(real);
  const contents = path.dirname(macos);
  const app = path.dirname(contents);
  return path.basename(macos) === 'MacOS' && path.basename(contents) === 'Contents' && path.basename(app) === CUA_APP ? app : null;
};

export const daemonLaunch = ({ binary, app, socketPath, env }) => (app
  ? {
    command: OPEN_COMMAND,
    args: ['-W', '-n', '-g', '-a', app, ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--args', 'serve', '--socket', socketPath],
  }
  : { command: binary, args: ['serve', '--socket', socketPath] });

export const probeSocket = (socketPath, { timeoutMs = PROBE_TIMEOUT_MS } = {}) => new Promise((resolve) => {
  const socket = net.connect({ path: socketPath });
  const done = (alive) => {
    clearTimeout(timer);
    socket.destroy();
    resolve(alive);
  };
  const timer = setTimeout(() => done(false), timeoutMs);
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
});

const MIB = 1024 * 1024;
const MAX_DRIVER_OUTPUT_BYTES = 64 * MIB;

const sizeText = (bytes) => (bytes >= MIB && bytes % MIB === 0 ? `${bytes / MIB} MiB` : `${bytes} bytes`);

const cancelled = (label) => new MittrToolError(`${label} was cancelled`, CANCELLED);

const pause = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const runChild = ({ spawn, command, args, stdio, env, cwd, label, timeoutMs, signal, maxOutputBytes = Number.POSITIVE_INFINITY }) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(cancelled(label));
    return;
  }
  const options = { stdio, signal, killSignal: 'SIGKILL' };
  if (env) options.env = env;
  if (cwd) options.cwd = cwd;
  const child = spawn(command, args, options);
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  let stopped = false;
  const stop = (error) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    child.kill('SIGKILL');
    reject(error);
  };
  const timer = setTimeout(() => stop(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  child.stdout?.on('data', (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > maxOutputBytes) stop(new Error(`${label} answered more than ${sizeText(maxOutputBytes)} and was stopped`));
    else stdout.push(Buffer.from(chunk));
  });
  child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  child.on('error', (error) => {
    clearTimeout(timer);
    reject(error?.name === 'AbortError' ? cancelled(label) : error);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    const failure = Buffer.concat(stderr).toString('utf8').trim();
    if (code !== 0) reject(new Error(failure || `${label} exited with code ${code}`));
    else resolve(Buffer.concat(stdout).toString('utf8'));
  });
});

const untilSettled = (work, signal, label) => {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(cancelled(label));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelled(label));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

export const createDriverDaemon = ({
  binary,
  dataDir,
  env = process.env,
  spawn = spawnChild,
  probe = probeSocket,
  appBundle = driverAppBundle,
  makeFolder = (folder) => fs.mkdirSync(folder, { recursive: true, mode: 0o700 }),
  startTimeoutMs = DAEMON_START_TIMEOUT_MS,
  stopTimeoutMs = DAEMON_STOP_TIMEOUT_MS,
  probeIntervalMs = PROBE_INTERVAL_MS,
}) => {
  const usable = Boolean(binary) && isText(dataDir) && path.isAbsolute(dataDir);
  const socketPath = usable ? driverSocketPath(dataDir) : null;
  const childEnv = usable ? driverEnv({ env, dataDir }) : {};
  let current = null;
  let starting = null;
  let stopping = null;

  const stopCommand = () => runChild({
    spawn,
    command: binary,
    args: ['stop', '--socket', socketPath],
    stdio: ['ignore', 'ignore', 'pipe'],
    env: childEnv,
    cwd: driverFolder(dataDir),
    label: 'cua-driver stop',
    timeoutMs: stopTimeoutMs,
  }).catch(() => {});

  const exitedWithin = (generation, ms) => (generation.alive
    ? Promise.race([generation.exited, pause(ms)])
    : Promise.resolve());

  const launch = async () => {
    if (!usable) throw new MittrToolError(NOT_BUNDLED, 503);
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
      throw new MittrToolError(`The Computer tool cannot use its driver socket: ${socketPath} is longer than ${MAX_SOCKET_PATH_BYTES} bytes`, 503);
    }
    makeFolder(driverFolder(dataDir));
    if (await probe(socketPath)) await stopCommand();
    const { command, args } = daemonLaunch({ binary, app: appBundle(binary), socketPath, env: childEnv });
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], env: childEnv, cwd: driverFolder(dataDir) });
    const stderr = [];
    let stderrBytes = 0;
    child.stderr?.on('data', (chunk) => {
      if (stderrBytes >= MAX_LAUNCHER_STDERR_BYTES) return;
      stderrBytes += chunk.length;
      stderr.push(Buffer.from(chunk));
    });
    const generation = { child, alive: true, failure: null };
    generation.exited = new Promise((resolve) => {
      child.once('close', () => {
        generation.alive = false;
        resolve();
      });
      child.once('error', (error) => {
        generation.alive = false;
        generation.failure = error;
        resolve();
      });
    });
    const deadline = Date.now() + startTimeoutMs;
    for (;;) {
      if (await probe(socketPath)) {
        if (generation.alive) return generation;
        break;
      }
      if (!generation.alive) break;
      if (Date.now() >= deadline) {
        child.kill('SIGKILL');
        await stopCommand();
        throw new Error(`cua-driver serve did not answer on ${socketPath} within ${startTimeoutMs}ms`);
      }
      await pause(probeIntervalMs);
    }
    await stopCommand();
    const said = Buffer.concat(stderr).toString('utf8').trim();
    throw new Error(generation.failure?.message || said || 'cua-driver serve exited before it answered');
  };

  const ensure = () => {
    if (current?.alive) return Promise.resolve();
    starting ??= (async () => {
      await stopping;
      current = await launch();
    })().finally(() => {
      starting = null;
    });
    return starting;
  };

  const stop = () => {
    stopping ??= (async () => {
      await starting?.catch(() => {});
      const generation = current;
      current = null;
      if (!generation) return;
      if (await probe(socketPath)) {
        await stopCommand();
        await exitedWithin(generation, stopTimeoutMs);
      }
      if (generation.alive) {
        generation.child.kill('SIGKILL');
        await exitedWithin(generation, stopTimeoutMs);
      }
    })().finally(() => {
      stopping = null;
    });
    return stopping;
  };

  const restart = async () => {
    await stop();
    await ensure();
  };

  return {
    usable,
    socketPath,
    env: childEnv,
    ensure,
    stop,
    restart,
    running: () => current?.alive === true,
  };
};

const daemonGone = (error, socketPath) => String(error?.message ?? '').includes(`daemon is not running on ${socketPath}`);

export const createComputerControl = ({
  binary,
  dataDir = null,
  env = process.env,
  spawn = spawnChild,
  daemon = createDriverDaemon({ binary, dataDir, env, spawn }),
  timeoutMs = CHILD_TIMEOUT_MS,
  maxOutputBytes = MAX_DRIVER_OUTPUT_BYTES,
}) => {
  const available = Boolean(binary) && daemon.usable !== false;

  const call = (tool, args, signal) => runChild({
    spawn,
    command: binary,
    args: ['call', tool, JSON.stringify(args ?? {}), '--socket', daemon.socketPath],
    stdio: ['ignore', 'pipe', 'pipe'],
    env: daemon.env,
    label: `cua-driver ${tool}`,
    timeoutMs,
    signal,
    maxOutputBytes,
  });

  const started = async (work, signal, label) => {
    try {
      await untilSettled(work(), signal, label);
    } catch (error) {
      if (error instanceof MittrToolError) throw error;
      throw new MittrToolError(DRIVER_DOWN, 503);
    }
  };

  return {
    available,
    socketPath: daemon.socketPath,
    stop: () => daemon.stop(),
    request: async (tool, args, { signal } = {}) => {
      if (!available) throw new MittrToolError(NOT_BUNDLED, 503);
      const label = `cua-driver ${tool}`;
      if (signal?.aborted) throw cancelled(label);
      await started(() => daemon.ensure(), signal, label);
      let output;
      try {
        output = await call(tool, args, signal);
      } catch (error) {
        if (!daemonGone(error, daemon.socketPath)) throw error;
        await started(() => daemon.restart(), signal, label);
        try {
          output = await call(tool, args, signal);
        } catch (again) {
          if (daemonGone(again, daemon.socketPath)) throw new MittrToolError(DRIVER_DOWN, 503);
          throw again;
        }
      }
      try {
        return JSON.parse(output);
      } catch {
        throw new Error(`${label} did not return JSON: ${output.slice(0, 200)}`);
      }
    },
  };
};

export const createLaunchApp = ({ spawn = spawnChild, timeoutMs = CHILD_TIMEOUT_MS } = {}) => async (name, { signal } = {}) => {
  await runChild({
    spawn,
    command: OPEN_COMMAND,
    args: ['-a', name],
    stdio: ['ignore', 'ignore', 'pipe'],
    label: `open -a "${name}"`,
    timeoutMs,
    signal,
  });
};

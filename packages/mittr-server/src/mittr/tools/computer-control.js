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

export const launchEnv = (env) => Object.fromEntries(Object.entries(env ?? {}).filter(([key, value]) => isText(value) && (PASSED_ENV.has(key) || key.startsWith('LC_'))));

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
  ...launchEnv(env),
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

const UNAVAILABLE = 'The Computer tool is not available in this install';
const CLOSED = 'MittrCraft is closing, so the Computer tool is not running';
export const DRIVER_STOPPED = 'The Computer tool was stopped while this action waited, so nothing was sent to the desktop';
const UNSAFE_FOLDER = 'The Computer tool cannot use its driver folder because it is not a plain folder owned by this user';
const PID_FILE = path.join('Library', 'Caches', CUA_DRIVER, `${CUA_DRIVER}.pid`);
const PS_COMMAND = '/bin/ps';

export const prepareDriverFolder = (folder) => {
  try {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  } catch {
    throw new MittrToolError(UNSAFE_FOLDER, 503);
  }
  const stat = fs.lstatSync(folder);
  const owned = typeof process.getuid !== 'function' || stat.uid === process.getuid();
  if (stat.isSymbolicLink() || !stat.isDirectory() || !owned) throw new MittrToolError(UNSAFE_FOLDER, 503);
  fs.chmodSync(folder, 0o700);
};

export const daemonPidFile = (home) => path.join(home, PID_FILE);

const readPidFile = (file) => {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
};

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const socketFits = (dataDir) => Buffer.byteLength(driverSocketPath(dataDir)) <= MAX_SOCKET_PATH_BYTES;

const quietLogger = { warn: () => {} };

export const createDriverDaemon = ({
  binary,
  dataDir,
  env = process.env,
  spawn = spawnChild,
  probe = probeSocket,
  appBundle = driverAppBundle,
  prepareFolder = prepareDriverFolder,
  readPid = readPidFile,
  commandOf = null,
  signalPid = (pid, signal) => process.kill(pid, signal),
  isAlive = pidAlive,
  logger = quietLogger,
  startTimeoutMs = DAEMON_START_TIMEOUT_MS,
  stopTimeoutMs = DAEMON_STOP_TIMEOUT_MS,
  probeIntervalMs = PROBE_INTERVAL_MS,
}) => {
  const usable = Boolean(binary) && isText(dataDir) && path.isAbsolute(dataDir) && socketFits(dataDir);
  const socketPath = usable ? driverSocketPath(dataDir) : null;
  const childEnv = usable ? driverEnv({ env, dataDir }) : {};
  let current = null;
  let starting = null;
  let halting = Promise.resolve();
  let stopEpoch = 0;
  let closed = false;

  const commandOfPid = commandOf ?? ((pid) => runChild({
    spawn,
    command: PS_COMMAND,
    args: ['-o', 'command=', '-p', String(pid)],
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: '/usr/bin:/bin' },
    label: 'ps',
    timeoutMs: stopTimeoutMs,
  }).then((text) => text.trim(), () => null));

  const stopCommand = () => runChild({
    spawn,
    command: binary,
    args: ['stop', '--socket', socketPath],
    stdio: ['ignore', 'ignore', 'pipe'],
    env: childEnv,
    cwd: driverFolder(dataDir),
    label: 'cua-driver stop',
    timeoutMs: stopTimeoutMs,
  }).then(() => true, () => false);

  const exitedWithin = (generation, ms) => (generation.alive
    ? Promise.race([generation.exited, pause(ms)])
    : Promise.resolve());

  const pidGoneWithin = async (pid, ms) => {
    const deadline = Date.now() + ms;
    while (isAlive(pid)) {
      if (Date.now() >= deadline) return false;
      await pause(probeIntervalMs);
    }
    return true;
  };

  const stopByPid = async (generation) => {
    logger.warn('[mittr] cua-driver did not stop through its socket; stopping it by its pid file');
    const home = childEnv.HOME;
    const pid = home ? readPid(daemonPidFile(home)) : null;
    if (pid === null) return;
    const expected = `${path.join(generation.app, 'Contents', 'MacOS', CUA_DRIVER)} serve --socket ${socketPath}`;
    if ((await commandOfPid(pid)) !== expected) return;
    try {
      signalPid(pid, 'SIGTERM');
      if (!(await pidGoneWithin(pid, stopTimeoutMs))) signalPid(pid, 'SIGKILL');
    } catch {
      return;
    }
  };

  const halt = async (generation) => {
    const answered = (await probe(socketPath)) && (await stopCommand());
    if (answered) await exitedWithin(generation, stopTimeoutMs);
    if (generation.app && (!answered || generation.alive)) await stopByPid(generation);
    if (generation.alive) {
      generation.child.kill('SIGKILL');
      await exitedWithin(generation, stopTimeoutMs);
    }
  };

  const haltLater = (generation) => {
    const work = halting.then(() => halt(generation));
    halting = work.catch(() => {});
    return work;
  };

  const launch = async (epoch) => {
    prepareFolder(driverFolder(dataDir));
    if (await probe(socketPath)) await stopCommand();
    const app = appBundle(binary);
    const { command, args } = daemonLaunch({ binary, app, socketPath, env: childEnv });
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], env: childEnv, cwd: driverFolder(dataDir) });
    const stderr = [];
    let stderrBytes = 0;
    child.stderr?.on('data', (chunk) => {
      if (stderrBytes >= MAX_LAUNCHER_STDERR_BYTES) return;
      stderrBytes += chunk.length;
      stderr.push(Buffer.from(chunk));
    });
    const generation = { child, app, epoch, alive: true, failure: null };
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
        await haltLater(generation);
        throw new Error(`cua-driver serve did not answer on ${socketPath} within ${startTimeoutMs}ms`);
      }
      await pause(probeIntervalMs);
    }
    await stopCommand();
    const said = Buffer.concat(stderr).toString('utf8').trim();
    throw new Error(generation.failure?.message || said || 'cua-driver serve exited before it answered');
  };

  const refusal = () => new MittrToolError(closed ? CLOSED : DRIVER_STOPPED, 503);

  const ensure = () => {
    if (closed) return Promise.reject(new MittrToolError(CLOSED, 503));
    if (!usable) return Promise.reject(new MittrToolError(UNAVAILABLE, 503));
    if (current?.alive) return Promise.resolve(current);
    if (!starting) {
      const epoch = stopEpoch;
      starting = (async () => {
        await halting;
        if (closed || stopEpoch !== epoch) throw refusal();
        const generation = await launch(epoch);
        if (closed || stopEpoch !== epoch) {
          await haltLater(generation);
          throw refusal();
        }
        current = generation;
        return generation;
      })().finally(() => {
        starting = null;
      });
    }
    return starting;
  };

  const stop = async () => {
    stopEpoch += 1;
    const generation = current;
    current = null;
    const pending = starting;
    if (generation) await haltLater(generation);
    await pending?.catch(() => {});
    await halting;
  };

  const close = async () => {
    closed = true;
    await stop();
  };

  const restart = async (generation) => {
    if (closed || !generation || generation.epoch !== stopEpoch) return null;
    if (current === generation) {
      current = null;
      await haltLater(generation);
    }
    if (closed || generation.epoch !== stopEpoch) return null;
    return ensure();
  };

  return {
    usable,
    socketPath,
    env: childEnv,
    ensure,
    stop,
    close,
    restart,
    running: () => current?.alive === true,
  };
};

const socketNames = (socketPath) => {
  try {
    return [socketPath, path.join(fs.realpathSync(path.dirname(socketPath)), path.basename(socketPath))];
  } catch {
    return [socketPath];
  }
};

const daemonGone = (error, socketPath) => {
  const text = String(error?.message ?? '');
  return socketNames(socketPath).some((name) => text.includes(`daemon is not running on ${name}`));
};

export const createComputerControl = ({
  binary,
  dataDir = null,
  env = process.env,
  spawn = spawnChild,
  logger = quietLogger,
  daemon = createDriverDaemon({ binary, dataDir, env, spawn, logger }),
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

  const down = (reason) => {
    logger.warn(`[mittr] the Computer tool's desktop driver is not running: ${reason}`);
    return new MittrToolError(DRIVER_DOWN, 503);
  };

  const started = async (work, signal, label) => {
    try {
      return await untilSettled(work(), signal, label);
    } catch (error) {
      if (error instanceof MittrToolError) throw error;
      throw down(error instanceof Error ? error.message : String(error));
    }
  };

  return {
    available,
    socketPath: daemon.socketPath,
    stop: () => daemon.stop(),
    close: () => daemon.close(),
    request: async (tool, args, { signal } = {}) => {
      if (!available) throw new MittrToolError(binary ? UNAVAILABLE : NOT_BUNDLED, 503);
      const label = `cua-driver ${tool}`;
      if (signal?.aborted) throw cancelled(label);
      const generation = await started(() => daemon.ensure(), signal, label);
      let output;
      try {
        output = await call(tool, args, signal);
      } catch (error) {
        if (!daemonGone(error, daemon.socketPath)) throw error;
        const next = await started(() => daemon.restart(generation), signal, label);
        if (!next) throw new MittrToolError(DRIVER_STOPPED, 503);
        try {
          output = await call(tool, args, signal);
        } catch (again) {
          if (daemonGone(again, daemon.socketPath)) throw down('it stopped again right after a restart');
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

export const createLaunchApp = ({ spawn = spawnChild, timeoutMs = CHILD_TIMEOUT_MS, env = process.env } = {}) => async (name, { signal } = {}) => {
  await runChild({
    spawn,
    command: OPEN_COMMAND,
    args: ['-a', name],
    stdio: ['ignore', 'ignore', 'pipe'],
    env: launchEnv(env),
    label: `open -a "${name}"`,
    timeoutMs,
    signal,
  });
};

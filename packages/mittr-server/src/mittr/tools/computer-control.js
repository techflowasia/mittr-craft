import { spawn as spawnChild } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { MittrToolError } from './registry.js';

const CUA_DRIVER = 'cua-driver';
export const OPEN_COMMAND = '/usr/bin/open';
const CHILD_TIMEOUT_MS = 15_000;

const NOT_BUNDLED = 'Computer use is not bundled in this build of MittrCraft';
const CANCELLED = 499;

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

const MIB = 1024 * 1024;
const MAX_DRIVER_OUTPUT_BYTES = 64 * MIB;

const sizeText = (bytes) => (bytes >= MIB && bytes % MIB === 0 ? `${bytes / MIB} MiB` : `${bytes} bytes`);

const cancelled = (label) => new MittrToolError(`${label} was cancelled`, CANCELLED);

const runChild = ({ spawn, command, args, stdio, label, timeoutMs, signal, maxOutputBytes = Number.POSITIVE_INFINITY }) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(cancelled(label));
    return;
  }
  const child = spawn(command, args, { stdio, signal, killSignal: 'SIGKILL' });
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

export const createComputerControl = ({ binary, spawn = spawnChild, timeoutMs = CHILD_TIMEOUT_MS, maxOutputBytes = MAX_DRIVER_OUTPUT_BYTES }) => ({
  available: Boolean(binary),
  request: async (tool, args, { signal } = {}) => {
    if (!binary) throw new MittrToolError(NOT_BUNDLED, 503);
    const label = `cua-driver ${tool}`;
    const output = await runChild({
      spawn,
      command: binary,
      args: [tool, JSON.stringify(args ?? {})],
      stdio: ['ignore', 'pipe', 'pipe'],
      label,
      timeoutMs,
      signal,
      maxOutputBytes,
    });
    try {
      return JSON.parse(output);
    } catch {
      throw new Error(`${label} did not return JSON: ${output.slice(0, 200)}`);
    }
  },
});

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

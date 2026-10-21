import { spawn as spawnChild } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { MittrToolError } from './registry.js';

const CUA_DRIVER = 'cua-driver';
export const OPEN_COMMAND = '/usr/bin/open';
const DRIVER_TIMEOUT_MS = 15_000;

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

const cancelled = (tool) => new MittrToolError(`cua-driver ${tool} was cancelled`, CANCELLED);

const runDriver = ({ spawn, binary, tool, args, timeoutMs, signal }) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(cancelled(tool));
    return;
  }
  const child = spawn(binary, [tool, JSON.stringify(args ?? {})], { stdio: ['ignore', 'pipe', 'pipe'], signal, killSignal: 'SIGKILL' });
  const stdout = [];
  const stderr = [];
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error(`cua-driver ${tool} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  child.on('error', (error) => {
    clearTimeout(timer);
    reject(error?.name === 'AbortError' ? cancelled(tool) : error);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    const output = Buffer.concat(stdout).toString('utf8');
    if (code !== 0) {
      reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `cua-driver ${tool} exited with code ${code}`));
      return;
    }
    try {
      resolve(JSON.parse(output));
    } catch {
      reject(new Error(`cua-driver ${tool} did not return JSON: ${output.slice(0, 200)}`));
    }
  });
});

export const createComputerControl = ({ binary, spawn = spawnChild, timeoutMs = DRIVER_TIMEOUT_MS }) => ({
  available: Boolean(binary),
  request: async (tool, args, { signal } = {}) => {
    if (!binary) throw new MittrToolError(NOT_BUNDLED, 503);
    return runDriver({ spawn, binary, tool, args, timeoutMs, signal });
  },
});

export const createLaunchApp = ({ spawn = spawnChild } = {}) => (name) => new Promise((resolve, reject) => {
  const child = spawn(OPEN_COMMAND, ['-a', name], { stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) resolve();
    else reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `open -a "${name}" exited with code ${code}`));
  });
});

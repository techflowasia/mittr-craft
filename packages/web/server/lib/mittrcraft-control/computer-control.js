/**
 * Runs the bundled `cua-driver` binary (see
 * `packages/electron/scripts/prepare-cua-driver.mjs`) as a plain child process.
 *
 * Unlike the browser panel, the desktop the driver controls lives on this same
 * machine and needs no renderer round trip — there is nothing to broker, only a
 * binary to invoke and its JSON stdout to parse.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const BINARY_NAME = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver';

const bundledBinaryCandidates = () => {
  const roots = [
    process.env.MITTRCRAFT_BUNDLED_CUA_DRIVER_DIR,
    typeof process.resourcesPath === 'string' ? path.join(process.resourcesPath, 'cua-driver') : null,
  ]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  return roots.map((root) => path.join(root, BINARY_NAME));
};

const resolveBinary = () => bundledBinaryCandidates().find((candidate) => fs.existsSync(candidate)) || null;

const runTool = (binary, toolName, args, { timeoutMs = 15_000 } = {}) => new Promise((resolve, reject) => {
  const child = spawn(binary, [toolName, JSON.stringify(args ?? {})], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error(`cua-driver ${toolName} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => { clearTimeout(timer); reject(error); });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code !== 0) {
      reject(new Error(stderr.trim() || `cua-driver ${toolName} exited with code ${code}`));
      return;
    }
    try {
      resolve(JSON.parse(stdout));
    } catch {
      reject(new Error(`cua-driver ${toolName} did not return JSON: ${stdout.slice(0, 200)}`));
    }
  });
});

/**
 * `binary` is resolved once at creation, not per call: a build that never
 * bundled cua-driver (Windows/Linux today, see the prepare script) should say
 * so up front rather than fail differently on the first real request.
 */
export const createComputerControl = ({ resolve = resolveBinary } = {}) => {
  const binary = resolve();

  const request = async (toolName, args, options) => {
    if (!binary) {
      throw new Error('Computer use is not bundled in this build of MittrCraft');
    }
    return runTool(binary, toolName, args, options);
  };

  return {
    available: binary !== null,
    request,
  };
};

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BINARY_NAME = 'agent-browser';
const MAX_OUTPUT_CHARS = 12_000;

const devResourcesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../electron/resources',
);

export const bundledAgentBrowserCandidates = () => [
  process.env.MITTRCRAFT_BUNDLED_AGENT_BROWSER_DIR,
  typeof process.resourcesPath === 'string' ? path.join(process.resourcesPath, 'agent-browser') : null,
  path.join(devResourcesDir, 'agent-browser'),
]
  .map((value) => (typeof value === 'string' ? value.trim() : ''))
  .filter(Boolean)
  .map((root) => path.join(root, BINARY_NAME));

const resolveBinary = () => bundledAgentBrowserCandidates().find((candidate) => fs.existsSync(candidate)) || null;

export const chromeSessionName = (sessionId) => `mc-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '')}`;

const executeBinary = (binary, argv, { env, signal }) => new Promise((resolve, reject) => {
  execFile(binary, argv, { env, signal, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
    if (error && !stdout) {
      reject(error);
      return;
    }
    resolve(stdout);
  });
});

const parseReply = (stdout) => {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`agent-browser did not return JSON: ${String(stdout).slice(0, 200)}`);
  }
  if (parsed?.success !== true) {
    throw new Error(typeof parsed?.error === 'string' && parsed.error ? parsed.error : 'agent-browser command failed');
  }
  return parsed.data;
};

export const createChromeControl = ({
  resolve = resolveBinary,
  chromePath = CHROME_EXECUTABLE,
  exists = fs.existsSync,
  execute = executeBinary,
} = {}) => {
  const binary = resolve();
  const env = { ...process.env, AGENT_BROWSER_EXECUTABLE_PATH: chromePath };

  const call = async (argv, signal) => {
    if (!binary) throw new Error('The Chrome tool is not bundled in this build of MittrCraft');
    return parseReply(await execute(binary, argv, { env, signal }));
  };

  const run = async (command, { sessionName, profile, headed = false, signal } = {}) => {
    const argv = [
      '--session', sessionName,
      '--profile', profile,
      '--json',
      ...(headed ? ['--headed'] : []),
      '--max-output', String(MAX_OUTPUT_CHARS),
      ...command,
    ];
    const data = await call(argv, signal);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const { lifecycle: _lifecycle, ...rest } = data;
      return rest;
    }
    return data;
  };

  const profiles = async () => {
    const data = await call(['--json', 'profiles']);
    return Array.isArray(data) ? data : [];
  };

  const closeAll = async () => {
    if (!binary) return;
    await call(['--json', 'close', '--all']).catch(() => undefined);
  };

  return {
    available: binary !== null,
    chromeInstalled: () => exists(chromePath),
    run,
    profiles,
    closeAll,
  };
};

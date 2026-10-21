import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

import { writePrivateIfChanged } from '../private-file.js';
import { isRecord } from '../values.js';
import { bundledDriverPath } from './computer-control.js';
import { MittrToolError } from './registry.js';

const AGENT_BROWSER = 'agent-browser';
export const CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_IN_APPLICATIONS = path.join('Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome');
const MAX_OUTPUT_CHARS = 12_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export const BANNER_FILE = 'mittr-chrome-banner.js';
export const CONFIG_FILE = 'mittr-agent-browser.json';
const EMPTY_CONFIG = '{}\n';

const NOT_BUNDLED = 'The Chrome tool is not bundled in this build of MittrCraft';
const CANCELLED = 'The Chrome action was cancelled';

const PASSED_ENV = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'CFFIXED_USER_HOME', 'AGENT_BROWSER_ARGS']);

export const resolveAgentBrowser = ({ resourcesDir, env, exists }) => bundledDriverPath({
  dirFromEnv: env.MITTRCRAFT_BUNDLED_AGENT_BROWSER_DIR,
  resourcesDir,
  name: AGENT_BROWSER,
  exists,
});

export const resolveChrome = ({ home, exists = fs.existsSync }) => {
  const candidates = home ? [CHROME_EXECUTABLE, path.join(home, CHROME_IN_APPLICATIONS)] : [CHROME_EXECUTABLE];
  return candidates.find((candidate) => exists(candidate)) ?? null;
};

const BANNER_TEXT = 'MittrCraft agent กำลังควบคุมหน้าต่างนี้ · MittrCraft agent is controlling this window';

export const AGENT_BANNER_SCRIPT = `(() => {
  const ID = 'mittrcraft-agent-banner';
  const mount = () => {
    if (!document.documentElement || document.getElementById(ID)) return;
    const host = document.createElement('div');
    host.id = ID;
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;right:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    const bar = document.createElement('div');
    bar.textContent = ${JSON.stringify(BANNER_TEXT)};
    bar.style.cssText = 'font:600 12px/1.6 -apple-system,system-ui,sans-serif;color:#1a1300;background:#ffd84d;text-align:center;padding:3px 8px;box-shadow:0 1px 4px rgba(0,0,0,.25);pointer-events:none;';
    root.appendChild(bar);
    document.documentElement.appendChild(host);
  };
  mount();
  document.addEventListener('DOMContentLoaded', mount);
  new MutationObserver(mount).observe(document, { childList: true, subtree: true });
})();
`;

export const chromeSessionName = (sessionId) => `mc-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '')}`;

const driverEnv = ({ env, chromePath, namespace }) => ({
  ...Object.fromEntries(Object.entries(env).filter(([key, value]) => (PASSED_ENV.has(key) || key.startsWith('LC_')) && value === String(value))),
  AGENT_BROWSER_EXECUTABLE_PATH: chromePath,
  AGENT_BROWSER_NAMESPACE: namespace,
});

const executeBinary = (binary, argv, { env, cwd, signal }) => new Promise((resolve, reject) => {
  execFile(binary, argv, { env, cwd, signal, killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER_BYTES }, (error, stdout) => {
    if (error && (error.name === 'AbortError' || !stdout)) {
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
    throw new Error(parsed?.error === String(parsed?.error) && parsed.error ? parsed.error : 'agent-browser command failed');
  }
  return parsed.data;
};

export const createChromeControl = ({
  binary,
  dataDir,
  chromePath = CHROME_EXECUTABLE,
  exists = fs.existsSync,
  execute = executeBinary,
  env = process.env,
}) => {
  const configPath = path.join(dataDir, CONFIG_FILE);
  const bannerPath = path.join(dataDir, BANNER_FILE);
  const childEnv = driverEnv({ env, chromePath, namespace: path.basename(dataDir) });

  const prepare = async ({ headed }) => {
    await fsPromises.mkdir(dataDir, { recursive: true });
    await writePrivateIfChanged(configPath, EMPTY_CONFIG);
    if (headed) await writePrivateIfChanged(bannerPath, AGENT_BANNER_SCRIPT);
  };

  const call = async (argv, { signal, headed = false } = {}) => {
    if (!binary) throw new MittrToolError(NOT_BUNDLED, 503);
    await prepare({ headed });
    let stdout;
    try {
      stdout = await execute(binary, ['--config', configPath, ...argv], { env: childEnv, cwd: dataDir, signal });
    } catch (error) {
      throw error?.name === 'AbortError' ? new MittrToolError(CANCELLED, 499) : error;
    }
    return parseReply(stdout);
  };

  const run = async (command, { sessionName, profile, headed = false, signal } = {}) => {
    const argv = [
      '--session', sessionName,
      '--profile', profile,
      '--json',
      ...(headed ? ['--headed', '--init-script', bannerPath] : []),
      '--max-output', String(MAX_OUTPUT_CHARS),
      ...command,
    ];
    const data = await call(argv, { signal, headed });
    if (!isRecord(data)) return data;
    const { lifecycle: _lifecycle, ...rest } = data;
    return rest;
  };

  const profiles = async () => {
    const data = await call(['--json', 'profiles']);
    return Array.isArray(data) ? data : [];
  };

  const sessions = async () => {
    const data = await call(['--json', 'session', 'list']);
    return isRecord(data) && Array.isArray(data.sessions) ? data.sessions.filter((name) => name === String(name)) : [];
  };

  const closeAll = async ({ signal } = {}) => {
    if (!binary) return;
    await call(['--json', 'close', '--all'], { signal }).catch(() => undefined);
  };

  return {
    available: Boolean(binary),
    chromeInstalled: () => exists(chromePath),
    run,
    profiles,
    sessions,
    closeAll,
  };
};

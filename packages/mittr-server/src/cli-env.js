import fs from 'node:fs';
import path from 'node:path';

const LEGACY_NAMES = {
  OPENCHAMBER_UI_PASSWORD: 'MITTRCRAFT_UI_PASSWORD',
  OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN: 'MITTRCRAFT_ALLOW_UNAUTHENTICATED_LAN',
  OPENCHAMBER_DATA_DIR: 'MITTRCRAFT_DATA_DIR',
};
const COMPANY_SIGN_IN_VARIABLE = /^MITTR_AD_/;
const DARWIN_ONLY = new Set(['OPENCHAMBER_POLICY_FILE']);
const PLAIN_SIGN_IN_SECRETS = ['MITTR_AD_CLIENT_SECRET', 'MITTR_AD_BIND_PASSWORD'];
export const BIN_BUN_BINARY = 'MITTRCRAFT_BIN_BUN_BINARY';
export const RIPGREP_MISSING_MESSAGE = 'ripgrep (rg) is not installed on this server. Install it, or set MITTRCRAFT_ALLOW_RIPGREP_DOWNLOAD=1 to let the engine download it from github.com.';
export const RIPGREP_DOWNLOAD_NOTICE = '[mittr] rg is missing; the engine will download it from github.com on first use';
const HELP_OR_VERSION_FLAGS = new Set(['--help', '-h', '--version', '-v']);
const COMMANDS_WITHOUT_SERVER = new Set(['stop', 'status', 'logs', 'schedule', 'session', 'models', 'projects', 'control', 'help', 'completion']);

const isUnset = (value) => typeof value !== 'string' || value.trim() === '';

const expandHome = (value, homeDir) => (String(value).startsWith('~/') ? path.join(homeDir, String(value).slice(2)) : value);

const resolveDir = (value, homeDir) => path.resolve(expandHome(String(value).trim(), homeDir));

const isInside = (dir, root) => {
  const relative = path.relative(root, dir);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const samePath = (left, right) => {
  const resolve = (file) => {
    try {
      return fs.realpathSync(file);
    } catch {
      return path.resolve(file);
    }
  };
  return resolve(left) === resolve(right);
};

const loadsPlugin = (specifiers, pluginPath) => {
  try {
    const parsed = JSON.parse(specifiers);
    return Array.isArray(parsed) && parsed.some((entry) => typeof entry === 'string' && path.isAbsolute(entry) && samePath(entry, pluginPath));
  } catch {
    return false;
  }
};

const findCheckoutRoot = (startDir) => {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

const envValue = (env, name, platform) => {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
};

export const searchPathOf = (env, platform = process.platform) => envValue(env, 'PATH', platform);

export const pathExtOf = (env, platform = process.platform) => envValue(env, 'PATHEXT', platform);

const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

const ripgrepNames = (platform, pathext) => {
  if (platform !== 'win32') return ['rg'];
  const extensions = (isUnset(pathext) ? WINDOWS_DEFAULT_PATHEXT : pathext).split(';').map((extension) => extension.trim().toLowerCase()).filter(Boolean);
  return [...new Set(['rg.exe', ...extensions.map((extension) => `rg${extension}`)])];
};

export const findRipgrep = (pathValue, { fs: fileSystem = fs, platform = process.platform, pathext } = {}) => {
  if (isUnset(pathValue)) return null;
  const windows = platform === 'win32';
  const join = windows ? path.win32.join : path.join;
  const names = ripgrepNames(platform, pathext);
  for (const dir of String(pathValue).split(windows ? ';' : path.delimiter)) {
    if (dir === '') continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (!fileSystem.statSync(candidate).isFile()) continue;
        if (!windows) fileSystem.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
};

const VALUE_FLAGS = new Set([
  'port', 'p', 'host', 'ui-password', 'provider', 'mode', 'profile', 'name', 'title', 'worktree', 'branch', 'start-ref', 'base',
  'project', 'dir', 'directory', 'task', 'session', 'message', 'prompt', 'model', 'daily', 'weekly', 'once', 'time', 'cron',
  'timezone', 'agent', 'variant', 'goal-token-budget', 'config', 'token', 'token-file', 'hostname', 'server', 'server-url',
  'connect-ttl', 'session-ttl', 'timeout', 'role', 'lines', 'limit',
]);

const positionalArguments = (argv) => {
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    const long = arg.startsWith('--');
    const name = long ? arg.slice(2).split('=')[0] : arg.slice(1);
    const next = argv[index + 1];
    if (VALUE_FLAGS.has(name) && !(long && arg.includes('=')) && typeof next === 'string' && (!next.startsWith('-') || /^-\d+$/.test(next))) index += 1;
  }
  return positional;
};

export const startsServer = (argv) => {
  if (argv.some((arg) => HELP_OR_VERSION_FLAGS.has(arg))) return false;
  const [command, subcommand] = positionalArguments(argv);
  if (command === 'startup') return subcommand === 'enable';
  if (command === 'tunnel') return subcommand === 'start';
  return !COMMANDS_WITHOUT_SERVER.has(command);
};

export const prepareCliEnvironment = ({ env, homeDir, pluginPath, productEnv, packageDir, platform = process.platform, nodePath = process.execPath, bunVersion = process.versions.bun }) => {
  const next = { ...env };
  const checkout = packageDir ? findCheckoutRoot(packageDir) : null;
  if (checkout && isUnset(next.OPENCHAMBER_DATA_DIR) && isUnset(next.MITTRCRAFT_DATA_DIR)) {
    return {
      env: next,
      refusal: `mittrcraft: this copy runs from a source checkout (${checkout}), so it will not use the installed app's data dir ${path.join(homeDir, '.config', 'mittrcraft')}. Set OPENCHAMBER_DATA_DIR or MITTRCRAFT_DATA_DIR to the data dir this server should use.`,
    };
  }
  for (const [name, legacy] of Object.entries(LEGACY_NAMES)) {
    if (isUnset(next[name]) && !isUnset(next[legacy])) next[name] = next[legacy];
  }
  const installedDataDir = path.join(homeDir, '.config', 'mittrcraft');
  const ownDataDir = isUnset(next.OPENCHAMBER_DATA_DIR) || samePath(resolveDir(next.OPENCHAMBER_DATA_DIR, homeDir), installedDataDir)
    ? null
    : resolveDir(next.OPENCHAMBER_DATA_DIR, homeDir);
  if (isUnset(next.OPENCHAMBER_DATA_DIR)) next.OPENCHAMBER_DATA_DIR = installedDataDir;
  if (ownDataDir && isUnset(next.MITTRCRAFT_ENGINE_HOME)) next.MITTRCRAFT_ENGINE_HOME = path.join(ownDataDir, 'engine');
  if (!isUnset(next.MITTRCRAFT_ENGINE_HOME) && isUnset(next.OPENCODE_CONFIG_DIR)) {
    next.OPENCODE_CONFIG_DIR = path.join(resolveDir(next.MITTRCRAFT_ENGINE_HOME, homeDir), 'opencode');
  }
  if (isUnset(next.OPENCHAMBER_SERVER_PLUGINS)) next.OPENCHAMBER_SERVER_PLUGINS = JSON.stringify([pluginPath]);
  for (const [name, value] of Object.entries(productEnv ?? {})) {
    if (DARWIN_ONLY.has(name) && platform !== 'darwin') continue;
    if (!isUnset(next[name])) continue;
    const expanded = expandHome(value, homeDir);
    next[name] = ownDataDir && !isUnset(expanded) && isInside(path.resolve(expanded), installedDataDir)
      ? path.join(ownDataDir, path.relative(installedDataDir, path.resolve(expanded)))
      : expanded;
  }
  if (isUnset(next.BUN_BINARY)) {
    next.BUN_BINARY = nodePath;
    next[BIN_BUN_BINARY] = nodePath;
  }

  const companySignIn = Object.keys(next).filter((name) => COMPANY_SIGN_IN_VARIABLE.test(name) && !isUnset(next[name])).sort();
  if (companySignIn.length > 0 && !loadsPlugin(next.OPENCHAMBER_SERVER_PLUGINS, pluginPath)) {
    return {
      env: next,
      refusal: `mittrcraft: company sign-in is configured (${companySignIn.join(', ')}), but OPENCHAMBER_SERVER_PLUGINS does not load ${pluginPath}, so the server would start without it. Unset OPENCHAMBER_SERVER_PLUGINS or add that path to it.`,
    };
  }
  const plainSecrets = PLAIN_SIGN_IN_SECRETS.filter((name) => !isUnset(next[name]));
  if (bunVersion && plainSecrets.length > 0) {
    return {
      env: next,
      refusal: `mittrcraft: this copy runs on Bun, which hands ${plainSecrets.join(' and ')} to every program the server starts, agents' commands included. Run mittrcraft with Node, or put each secret in a file named by ${plainSecrets.map((name) => `${name}_FILE`).join(' and ')} and unset ${plainSecrets.length > 1 ? 'the plain variables' : 'the plain variable'}.`,
    };
  }
  return {
    env: next,
    refusal: null,
    ripgrep: { found: findRipgrep(searchPathOf(next, platform), { platform, pathext: pathExtOf(next, platform) }), downloadAllowed: next.MITTRCRAFT_ALLOW_RIPGREP_DOWNLOAD === '1' },
  };
};

export const readProductEnv = (productFile) => JSON.parse(fs.readFileSync(productFile, 'utf8')).env ?? {};

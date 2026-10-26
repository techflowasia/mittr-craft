import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME_PREFIX = 'mittr-test-home-';

const SCRUBBED = [/^OPENCODE/, /^MITTR/, /^OPENCHAMBER/, /^XDG_/, /^GIT_/];

export const realUserHome = () => os.userInfo().homedir;

const resolved = (target) => {
  const absolute = path.resolve(target);
  const rest = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
};

const inside = (child, parent) => {
  const relative = path.relative(resolved(parent), resolved(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

export const createIsolatedHome = () => {
  const home = fs.mkdtempSync(path.join(resolved(os.tmpdir()), HOME_PREFIX));
  for (const relative of ['.config', '.local/share', '.local/state', '.cache']) {
    fs.mkdirSync(path.join(home, relative), { recursive: true });
  }
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Test Runner\n\temail = test-runner@example.invalid\n');
  return home;
};

export const isolatedEnv = ({ home, parentEnv = process.env, realHome = realUserHome() }) => {
  const env = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value !== undefined && !SCRUBBED.some((pattern) => pattern.test(name))) env[name] = value;
  }
  if (!env.NVM_DIR && fs.existsSync(path.join(realHome, '.nvm'))) env.NVM_DIR = path.join(realHome, '.nvm');
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    GIT_CONFIG_NOSYSTEM: '1',
    npm_config_cache: path.join(home, '.npm'),
    BUN_INSTALL: path.join(home, '.bun'),
    BUN_INSTALL_CACHE_DIR: path.join(home, '.bun', 'install', 'cache'),
  };
};

export class RealHomeError extends Error {}

export const assertIsolatedEnv = (env, { realHome = realUserHome() } = {}) => {
  const refuse = (reason) => {
    throw new RealHomeError(`refusing to run tests: ${reason}. Test runs must never write to the real home (${realHome}).`);
  };
  if (!env.HOME) refuse('HOME is not set');
  if (resolved(env.HOME) === resolved(realHome)) refuse('HOME is the real user home');
  if (inside(realHome, env.HOME)) refuse('HOME contains the real user home');
  for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    if (!env[name]) refuse(`${name} is not set`);
    if (!inside(env[name], env.HOME)) refuse(`${name} is outside the temporary HOME`);
  }
  if (env.OPENCHAMBER_DATA_DIR && !inside(env.OPENCHAMBER_DATA_DIR, env.HOME)) refuse('OPENCHAMBER_DATA_DIR is outside the temporary HOME');
  const leaked = Object.keys(env).find((name) => /^(OPENCODE|MITTR)/.test(name));
  if (leaked) refuse(`${leaked} is still set`);
  return env;
};

const removable = (home) => path.basename(home).startsWith(HOME_PREFIX) && inside(home, os.tmpdir());

export const STALE_HOME_MS = 60 * 60 * 1000;

export const sweepStaleHomes = ({ tmp = os.tmpdir(), maxAgeMs = STALE_HOME_MS, now = Date.now(), realHome = realUserHome() } = {}) => {
  const root = resolved(tmp);
  const removed = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(HOME_PREFIX)) continue;
    const target = path.join(root, entry.name);
    if (resolved(target) !== target || !inside(target, root)) continue;
    if (inside(realHome, target)) continue;
    try {
      if (now - fs.statSync(target).mtimeMs <= maxAgeMs) continue;
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(target);
    } catch {
      continue;
    }
  }
  return removed;
};

export const withIsolatedEnv = (run, { makeHome = createIsolatedHome, parentEnv = process.env, realHome = realUserHome() } = {}) => {
  const home = makeHome();
  try {
    return run(assertIsolatedEnv(isolatedEnv({ home, parentEnv, realHome }), { realHome }));
  } finally {
    if (removable(home) && resolved(home) !== resolved(realHome)) fs.rmSync(home, { recursive: true, force: true });
  }
};

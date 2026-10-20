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

const isUnset = (value) => typeof value !== 'string' || value.trim() === '';

const expandHome = (value, homeDir) => (String(value).startsWith('~/') ? path.join(homeDir, String(value).slice(2)) : value);

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
  if (isUnset(next.OPENCHAMBER_DATA_DIR)) next.OPENCHAMBER_DATA_DIR = path.join(homeDir, '.config', 'mittrcraft');
  if (isUnset(next.OPENCHAMBER_SERVER_PLUGINS)) next.OPENCHAMBER_SERVER_PLUGINS = JSON.stringify([pluginPath]);
  for (const [name, value] of Object.entries(productEnv ?? {})) {
    if (DARWIN_ONLY.has(name) && platform !== 'darwin') continue;
    if (isUnset(next[name])) next[name] = expandHome(value, homeDir);
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
  return { env: next, refusal: null };
};

export const readProductEnv = (productFile) => JSON.parse(fs.readFileSync(productFile, 'utf8')).env ?? {};

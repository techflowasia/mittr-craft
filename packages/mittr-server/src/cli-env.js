import fs from 'node:fs';
import path from 'node:path';

const LEGACY_NAMES = {
  OPENCHAMBER_UI_PASSWORD: 'MITTRCRAFT_UI_PASSWORD',
  OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN: 'MITTRCRAFT_ALLOW_UNAUTHENTICATED_LAN',
  OPENCHAMBER_DATA_DIR: 'MITTRCRAFT_DATA_DIR',
};
const COMPANY_SIGN_IN_VARIABLE = /^MITTR_AD_/;

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

export const prepareCliEnvironment = ({ env, homeDir, pluginPath, productEnv, packageDir }) => {
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
    if (isUnset(next[name])) next[name] = expandHome(value, homeDir);
  }

  const companySignIn = Object.keys(next).filter((name) => COMPANY_SIGN_IN_VARIABLE.test(name) && !isUnset(next[name])).sort();
  if (companySignIn.length > 0 && !loadsPlugin(next.OPENCHAMBER_SERVER_PLUGINS, pluginPath)) {
    return {
      env: next,
      refusal: `mittrcraft: company sign-in is configured (${companySignIn.join(', ')}), but OPENCHAMBER_SERVER_PLUGINS does not load ${pluginPath}, so the server would start without it. Unset OPENCHAMBER_SERVER_PLUGINS or add that path to it.`,
    };
  }
  return { env: next, refusal: null };
};

export const readProductEnv = (productFile) => JSON.parse(fs.readFileSync(productFile, 'utf8')).env ?? {};

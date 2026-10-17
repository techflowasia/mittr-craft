import fs from 'node:fs';
import path from 'node:path';

const LEGACY_NAMES = {
  OPENCHAMBER_UI_PASSWORD: 'MITTRCRAFT_UI_PASSWORD',
  OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN: 'MITTRCRAFT_ALLOW_UNAUTHENTICATED_LAN',
  OPENCHAMBER_DATA_DIR: 'MITTRCRAFT_DATA_DIR',
};
const BROKER_VARIABLE = /^MITTRCRAFT_BROKER_/;
const COMPANY_SIGN_IN_VARIABLE = /^MITTR_AD_/;

const isUnset = (value) => typeof value !== 'string' || value.trim() === '';

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

export const prepareCliEnvironment = ({ env, homeDir, pluginPath, productEnv }) => {
  const next = { ...env };
  for (const [name, legacy] of Object.entries(LEGACY_NAMES)) {
    if (isUnset(next[name]) && !isUnset(next[legacy])) next[name] = next[legacy];
  }
  if (isUnset(next.OPENCHAMBER_DATA_DIR)) next.OPENCHAMBER_DATA_DIR = path.join(homeDir, '.config', 'mittrcraft');
  if (isUnset(next.OPENCHAMBER_SERVER_PLUGINS)) next.OPENCHAMBER_SERVER_PLUGINS = JSON.stringify([pluginPath]);
  for (const [name, value] of Object.entries(productEnv ?? {})) {
    if (BROKER_VARIABLE.test(name) && isUnset(next[name])) next[name] = value;
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_ENV_FILE_SEGMENTS = ['.config', 'openchamber', 'desktop.env'];

export const resolveDesktopServerEnvFile = ({
  environment = process.env,
  homeDirectory = os.homedir(),
} = {}) => {
  const configuredPath = String(environment.OPENCHAMBER_DESKTOP_ENV_FILE ?? '').trim();
  return configuredPath
    ? path.resolve(configuredPath)
    : path.join(homeDirectory, ...DEFAULT_ENV_FILE_SEGMENTS);
};

export const loadDesktopServerEnv = ({
  environment = process.env,
  homeDirectory = os.homedir(),
  platform = process.platform,
  statSync = fs.statSync,
  loadEnvFile = process.loadEnvFile,
} = {}) => {
  const filePath = resolveDesktopServerEnvFile({ environment, homeDirectory });
  let stat;
  try {
    stat = statSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing', filePath };
    throw error;
  }

  if (!stat.isFile()) {
    throw new Error(`Desktop server environment path is not a file: ${filePath}`);
  }
  if (platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`Desktop server environment file must use permissions 0600: ${filePath}`);
  }
  loadEnvFile(filePath);
  return { status: 'loaded', filePath };
};

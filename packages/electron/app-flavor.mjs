import os from 'node:os';
import path from 'node:path';

const FLAVORS = {
  production: {
    id: 'production',
    appId: 'dev.mittrcraft.desktop',
    productName: 'MittrCraft',
    protocol: 'mittrcraft',
    dataDirName: 'mittrcraft',
    desktopPort: 57123,
    updates: true,
  },
  dev: {
    id: 'dev',
    appId: 'dev.mittrcraft.desktop.dev',
    productName: 'MittrCraft Dev',
    protocol: 'mittrcraft-dev',
    dataDirName: 'mittrcraft-dev',
    desktopPort: 57133,
    updates: false,
  },
};

export const resolveAppFlavor = (name) => {
  const key = String(name ?? '').trim() || 'production';
  const flavor = FLAVORS[key];
  if (!flavor) {
    throw new Error(`Unknown MittrCraft app flavor "${key}". Use one of: ${Object.keys(FLAVORS).join(', ')}`);
  }
  return flavor;
};

const bakedFlavor = typeof __MITTRCRAFT_APP_FLAVOR__ === 'string' ? __MITTRCRAFT_APP_FLAVOR__ : null;

export const APP_FLAVOR = resolveAppFlavor(bakedFlavor ?? process.env.MITTRCRAFT_APP_FLAVOR);

export const flavorEnvironment = (flavor, homeDir = os.homedir()) => {
  if (flavor.id === 'production') return {};
  const dataDir = path.join(homeDir, '.config', flavor.dataDirName);
  return {
    MITTRCRAFT_DATA_DIR: dataDir,
    MITTRCRAFT_ENGINE_HOME: path.join(dataDir, 'engine'),
    MITTRCRAFT_DEEP_LINK_SCHEME: flavor.protocol,
  };
};

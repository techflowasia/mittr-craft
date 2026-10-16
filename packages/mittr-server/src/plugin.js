import os from 'node:os';
import path from 'node:path';

import { activeAccountHome } from './accounts.js';
import { backupOnce } from './backup.js';
import { ENGINE_DB_RULE, engineBases, engineEnv } from './engine-home.js';
import { UPSTREAM_SETTINGS_KEYS, migrateSettingsOnce } from './settings.js';

/**
 * MittrCraft's server plugin, loaded through `OPENCHAMBER_SERVER_PLUGINS`.
 *
 * Before the first OpenCode 2 start it copies the engine folders and the data
 * dir aside once, then brings `settings.json` to upstream's names. It then
 * hands the server the engine environment on every engine start, read fresh
 * each time so an account switch takes effect on the next restart.
 */

const BACKUP_MARKER = '.pre-2x-backup-done';
const DEV_DATA_DIR = 'mittrcraft-dev';

// Downloaded speech models: hundreds of megabytes the app fetches again on
// demand, and nothing a user wrote.
const REFETCHABLE = ['speech-models'];

const flavorOf = (dataDir) => (path.basename(dataDir) === DEV_DATA_DIR ? 'dev' : 'prod');

export const setupMittrServer = async ({ dataDir, logger, env, homeDir }) => {
  const bases = engineBases({ homeDir, env });

  const backup = await backupOnce({
    dirs: [bases.config, bases.data, bases.state, bases.cache, dataDir],
    marker: path.join(dataDir, BACKUP_MARKER),
    exclude: REFETCHABLE.map((entry) => path.join(dataDir, entry)),
  });
  for (const where of backup.where) logger.log(`[mittr] backed up before the first OpenCode 2 start: ${where}`);

  try {
    const settings = await migrateSettingsOnce({ dataDir, flavor: flavorOf(dataDir), upstreamKeys: UPSTREAM_SETTINGS_KEYS });
    if (settings.renamed.length > 0 || settings.moved.length > 0 || settings.portReset) {
      logger.log('[mittr] settings brought to upstream names:', JSON.stringify(settings));
    }
  } catch (error) {
    logger.warn('[mittr] could not migrate settings; trying again next start:', error?.message ?? error);
  }

  return {
    engineEnv: () => engineEnv({ bases, accountHome: activeAccountHome(dataDir, { logger }), rule: ENGINE_DB_RULE }),
  };
};

export default async function setup({ dataDir, logger }) {
  return setupMittrServer({ dataDir, logger, env: process.env, homeDir: os.homedir() });
}

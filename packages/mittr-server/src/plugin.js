import os from 'node:os';
import path from 'node:path';

import { activeAccountHome } from './accounts.js';
import { backupOnce } from './backup.js';
import { ENGINE_DB_RULE, engineBases, engineEnv, sharedHistoryExists } from './engine-home.js';
import { ensureGitIdentityStore } from './git-identities.js';
import { setupMittr } from './mittr/index.js';
import { MITTR_SETTINGS_KEYS, UPSTREAM_SETTINGS_KEYS, migrateSettingsOnce } from './settings.js';

/**
 * MittrCraft's server plugin, loaded through `OPENCHAMBER_SERVER_PLUGINS`.
 *
 * Before the first OpenCode 2 start it copies the engine folders and the data
 * dir aside once, then brings `settings.json` to upstream's names and gives
 * the data dir its own git identity store. It then hands the server the
 * engine environment on every engine start, read fresh each time so an
 * account switch takes effect on the next restart. Given the server's
 * context, it also sets up Mittr sign-in on the server.
 */

const BACKUP_MARKER = '.pre-2x-backup-done';
const DEV_DATA_DIR = 'mittrcraft-dev';

// Downloaded speech models: hundreds of megabytes the app fetches again on
// demand, and nothing a user wrote.
const REFETCHABLE = ['speech-models'];

const flavorOf = (dataDir) => (path.basename(dataDir) === DEV_DATA_DIR ? 'dev' : 'prod');

export const setupMittrServer = async ({ dataDir, logger, env, homeDir, context = null }) => {
  // Without its own engine root a Dev build would resolve prod's engine
  // folders, and back up, migrate and run on the installed app's database.
  if (flavorOf(dataDir) === 'dev' && !String(env.MITTRCRAFT_ENGINE_HOME ?? '').trim()) {
    throw new Error(
      `MittrCraft Dev (data dir ${dataDir}) needs MITTRCRAFT_ENGINE_HOME; refusing to start on the prod engine folders`,
    );
  }
  const bases = engineBases({ homeDir, env });

  const backup = await backupOnce({
    dirs: [bases.config, bases.data, bases.state, bases.cache, dataDir],
    marker: path.join(dataDir, BACKUP_MARKER),
    exclude: REFETCHABLE.map((entry) => path.join(dataDir, entry)),
  });
  for (const where of backup.where) logger.log(`[mittr] backed up before the first OpenCode 2 start: ${where}`);
  for (const kept of backup.kept) logger.log(`[mittr] kept the existing backup from before OpenCode 2: ${kept}`);

  try {
    const settings = await migrateSettingsOnce({
      dataDir,
      upstreamKeys: UPSTREAM_SETTINGS_KEYS,
      mittrKeys: MITTR_SETTINGS_KEYS,
    });
    if (settings.renamed.length > 0 || settings.moved.length > 0) {
      logger.log('[mittr] settings brought to upstream names:', JSON.stringify(settings));
    }
  } catch (error) {
    logger.warn('[mittr] could not migrate settings; trying again next start:', error?.message ?? error);
  }

  const identities = await ensureGitIdentityStore({ dataDir, homeDir, logger });
  if (identities.seededFrom) logger.log(`[mittr] git identities copied from ${identities.seededFrom}`);

  const baseEngineEnv = () => engineEnv({ bases, accountHome: activeAccountHome(dataDir, { logger }), rule: ENGINE_DB_RULE });
  if (!context) return { engineEnv: baseEngineEnv };

  const mittr = setupMittr(context, { env, sharedHistoryExists: () => sharedHistoryExists(bases) });
  return {
    engineEnv: async () => ({ ...baseEngineEnv(), ...(await mittr.engineEnv()) }),
    managedConfig: mittr.managedConfig,
    dispose: mittr.dispose,
  };
};

export default async function setup(context) {
  const { dataDir, logger } = context;
  return setupMittrServer({ dataDir, logger, env: process.env, homeDir: os.homedir(), context });
}

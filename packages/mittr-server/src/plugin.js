import os from 'node:os';
import path from 'node:path';

import { activeAccountHome } from './accounts.js';
import { backupOnce } from './backup.js';
import { BIN_BUN_BINARY } from './cli-env.js';
import { ENGINE_DB_RULE, engineBases, engineConfigDir, engineEnv, sharedHistoryExists } from './engine-home.js';
import { ENGINE_OUTBOUND_OFF } from './engine-outbound.js';
import { bundledRipgrep, placeEngineRipgrep } from './engine-ripgrep.js';
import { ensureGitIdentityStore } from './git-identities.js';
import { setupMittr } from './mittr/index.js';
import { MITTR_SETTINGS_KEYS, UPSTREAM_SETTINGS_KEYS, migrateSettingsOnce } from './settings.js';
import { registerCompanySignIn } from './ui-auth/routes.js';
import { SECRET_FILE_VARIABLES, readSecretFiles } from './ui-auth/secret-files.js';
import { registerBrandedWeb } from './web-brand.js';

/**
 * MittrCraft's server plugin, loaded through `OPENCHAMBER_SERVER_PLUGINS`.
 *
 * Before the first OpenCode 2 start it copies the engine folders and the data
 * dir aside once, then brings `settings.json` to upstream's names and gives
 * the data dir its own git identity store. It then hands the server the
 * engine environment on every engine start, read fresh each time so an
 * account switch takes effect on the next restart. Given the server's
 * context, it also sets up Mittr sign-in on the server and, when the environment
 * configures one, company directory or Microsoft sign-in for browser sessions.
 */

const BACKUP_MARKER = '.pre-2x-backup-done';
const DEV_DATA_DIR = 'mittrcraft-dev';

// Downloaded speech models: hundreds of megabytes the app fetches again on
// demand, and nothing a user wrote.
const REFETCHABLE = ['speech-models'];

const flavorOf = (dataDir) => (path.basename(dataDir) === DEV_DATA_DIR ? 'dev' : 'prod');

const COMPANY_SIGN_IN_VARIABLE = /^MITTR_AD_/;

export const SERVER_ONLY_SECRETS = [
  'OPENCHAMBER_UI_PASSWORD',
  'MITTRCRAFT_UI_PASSWORD',
  'OPENCODE_UI_PASSWORD',
  'OPENCODE_JWT_SECRET',
  'OPENCHAMBER_TUNNEL_TOKEN',
  'NGROK_AUTHTOKEN',
  'OPENCHAMBER_APNS_P8',
  'OPENCHAMBER_APNS_KEY_ID',
  'OPENCHAMBER_APNS_TEAM_ID',
  'OPENCHAMBER_LINEAR_CLIENT_SECRET',
  'OPENCHAMBER_JEV_API_KEY',
  'JIRA_TOKEN',
  'PLANE_API_KEY',
];

const takeBinRuntimePin = (env) => {
  if (!Object.hasOwn(env, BIN_BUN_BINARY)) return [];
  const pinned = String(env[BIN_BUN_BINARY] ?? '').trim();
  const taken = [BIN_BUN_BINARY];
  if (pinned && env.BUN_BINARY === pinned) {
    delete env.BUN_BINARY;
    taken.push('BUN_BINARY');
  }
  delete env[BIN_BUN_BINARY];
  return taken;
};

const companySignInNamesIn = (env) => Object.keys(env).filter((name) => COMPANY_SIGN_IN_VARIABLE.test(name));

const takeCompanySignInEnv = (env) => {
  const taken = {};
  for (const name of companySignInNamesIn(env)) {
    taken[name] = env[name];
    delete env[name];
  }
  return taken;
};

export const setupMittrServer = async ({ dataDir, logger, env, homeDir, context = null, resourcesDir = null, mintShimKey }) => {
  const takenSignInEnv = takeCompanySignInEnv(env);
  const runtimePin = takeBinRuntimePin(env);
  const withheld = Object.fromEntries([...Object.keys(takenSignInEnv), ...Object.values(SECRET_FILE_VARIABLES), ...SERVER_ONLY_SECRETS, ...runtimePin].map((name) => [name, undefined]));
  const companySignInEnv = readSecretFiles(takenSignInEnv);
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

  const ripgrep = bundledRipgrep(resourcesDir);
  let ripgrepWarned = false;
  let ripgrepPlaced = false;
  const placeRipgrep = () => {
    if (ripgrepPlaced) return;
    try {
      placeEngineRipgrep({ bundled: ripgrep, bases });
      ripgrepPlaced = true;
    } catch (error) {
      if (ripgrepWarned) return;
      ripgrepWarned = true;
      logger.warn('[mittr] could not put the bundled rg where the engine looks for it:', error?.message ?? error);
    }
  };
  const withheldNow = () => ({ ...withheld, ...Object.fromEntries(companySignInNamesIn(env).map((name) => [name, undefined])) });
  const baseEngineEnv = (accountHome) => {
    placeRipgrep();
    return {
      ...engineEnv({ bases, accountHome, rule: ENGINE_DB_RULE }),
      ...ENGINE_OUTBOUND_OFF,
      ...withheldNow(),
    };
  };
  if (!context) return { engineEnv: () => baseEngineEnv(activeAccountHome(dataDir, { logger })) };

  const companySignIn = registerCompanySignIn(context, { env: companySignInEnv, logger });
  if (companySignIn.enabled) logger.log(`[mittr] company sign-in (${companySignIn.mode}) is required for browser sessions`);
  registerBrandedWeb(context, { env, logger });
  const mittr = setupMittr(context, {
    env,
    sharedHistoryExists: () => sharedHistoryExists(bases),
    engineConfigDir: engineConfigDir({ bases, env }),
    engineDataHome: (accountHome) => engineEnv({ bases, accountHome, rule: ENGINE_DB_RULE }).XDG_DATA_HOME,
    mintShimKey,
    companySignIn: companySignIn.enabled,
    resourcesDir,
  });
  return {
    engineEnv: async () => ({ ...baseEngineEnv(mittr.engineHome()), ...(await mittr.engineEnv()), ...withheldNow() }),
    managedConfig: mittr.managedConfig,
    neverAutoAnswer: mittr.neverAutoAnswer,
    dispose: async () => {
      try {
        await mittr.dispose();
      } finally {
        companySignIn.dispose();
      }
    },
  };
};

export default async function setup(context) {
  const { dataDir, logger } = context;
  return setupMittrServer({ dataDir, logger, env: process.env, homeDir: os.homedir(), context, resourcesDir: process.resourcesPath ?? null });
}

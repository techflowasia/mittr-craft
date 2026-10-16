import fs from 'node:fs/promises';
import path from 'node:path';

import registry from '../../web/server/lib/opencode/settings-registry.json' with { type: 'json' };

/**
 * Every top-level `settings.json` key upstream reads: the settings registry,
 * plus the keys the desktop shell keeps outside it and the legacy keys
 * upstream's own settings code still reads and converts.
 */
export const UPSTREAM_SETTINGS_KEYS = Object.freeze(
  new Set([
    ...Object.keys(registry.fields),
    // packages/electron/main.mjs and early-startup.mjs
    'desktopLocalClientToken',
    'desktopInitialHostChoiceCompleted',
    'themeMode',
    // packages/web/server/lib/opencode/settings-runtime.js and settings-helpers.js
    'approvedDirectories',
    'collapsedProjects',
    'namedTunnelHostname',
    'namedTunnelToken',
    'namedTunnelPresets',
    'namedTunnelPresetTokens',
    'namedTunnelSelectedPresetId',
    'showOpenCodeRestartConfirm',
  ]),
);

const SETTINGS_FILE = 'settings.json';
const MARKER_FILE = '.pre-2x-settings-done';
const PARKED = 'mittr';
const PROD_PORT = 57123;
const DEV_PORT = 57133;

// 1.x renamed upstream's names to its own; reversing the spelling gives the
// name upstream reads.
const SPELLINGS = [
  ['mittrcraft', 'openchamber'],
  ['MittrCraft', 'OpenChamber'],
  ['Mittrcraft', 'Openchamber'],
  ['MITTRCRAFT', 'OPENCHAMBER'],
];
const upstreamNameOf = (key) => SPELLINGS.reduce((name, [ours, theirs]) => name.split(ours).join(theirs), key);

// A JSON object, as opposed to an array, a primitive or null.
const isPlainObject = (value) => value != null && Object.getPrototypeOf(value) === Object.prototype;

const exists = async (target) => {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

const readSettings = async (file) => {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (!isPlainObject(parsed)) throw new Error(`${file} does not hold a JSON object`);
  return parsed;
};

// The same atomic replace upstream uses for this file: Electron reads it with
// a plain readFile and would take a half-written file for an empty one.
const writeSettings = async (file, settings) => {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
};

const convert = (settings, { flavor, upstreamKeys }) => {
  const next = {};
  const parked = isPlainObject(settings[PARKED]) ? { ...settings[PARKED] } : {};
  // The value 1.x actually used wins over one already under the upstream name.
  const renames = {};
  const renamed = [];
  const moved = [];
  for (const [key, value] of Object.entries(settings)) {
    if (key === PARKED && isPlainObject(value)) continue;
    if (upstreamKeys.has(key)) {
      next[key] = value;
      continue;
    }
    const upstreamName = upstreamNameOf(key);
    if (upstreamName !== key && upstreamKeys.has(upstreamName)) {
      renames[upstreamName] = value;
      renamed.push(key);
      continue;
    }
    parked[key] = value;
    moved.push(key);
  }
  Object.assign(next, renames);
  if (Object.keys(parked).length > 0) next[PARKED] = parked;

  // A Dev install that saved the prod port would fight the installed app for
  // it. Electron reads this before the server starts, so it applies from the
  // next launch.
  const portReset = flavor === 'dev' && next.desktopLocalPort === PROD_PORT;
  if (portReset) next.desktopLocalPort = DEV_PORT;
  return { next, renamed, moved, portReset };
};

/**
 * Brings a 1.x `settings.json` to the names upstream reads, once per data
 * dir. A key with a MittrCraft spelling of an upstream name gets the upstream
 * name; any other key upstream does not know moves under `mittr`, where
 * upstream leaves it alone. Rejects without marking when the file cannot be
 * read or written, so the next start tries again.
 */
export const migrateSettingsOnce = async ({ dataDir, flavor, upstreamKeys }) => {
  const marker = path.join(dataDir, MARKER_FILE);
  const nothing = { renamed: [], moved: [], portReset: false };
  if (await exists(marker)) return nothing;

  const file = path.join(dataDir, SETTINGS_FILE);
  const settings = await readSettings(file);
  const result = settings ? convert(settings, { flavor, upstreamKeys }) : null;
  if (result && (result.renamed.length > 0 || result.moved.length > 0 || result.portReset)) {
    await writeSettings(file, result.next);
  }

  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(marker, `${new Date().toISOString()}\n`);
  return result ? { renamed: result.renamed, moved: result.moved, portReset: result.portReset } : nothing;
};

import fs from 'node:fs/promises';
import path from 'node:path';

import registry from '../../web/server/lib/opencode/settings-registry.json' with { type: 'json' };
import { isPlainObject } from './mittr/values.js';

/**
 * Top-level `settings.json` keys upstream reads: the settings registry, plus
 * the keys the desktop shell and server keep outside it, including legacy
 * keys upstream still reads as a fallback. A 1.x key with a MittrCraft
 * spelling of one of these is renamed to it.
 */
export const UPSTREAM_SETTINGS_KEYS = Object.freeze(
  new Set([
    ...Object.keys(registry.fields),
    // packages/electron/main.mjs and early-startup.mjs
    'desktopLocalClientToken',
    'desktopInitialHostChoiceCompleted',
    'themeMode',
    'splashBgLight',
    'splashFgLight',
    'splashBgDark',
    'splashFgDark',
    // packages/web/server/lib/opencode/settings-runtime.js and settings-helpers.js
    'approvedDirectories',
    'collapsedProjects',
    'namedTunnelHostname',
    'namedTunnelToken',
    'namedTunnelPresets',
    'namedTunnelPresetTokens',
    'namedTunnelSelectedPresetId',
    'showOpenCodeRestartConfirm',
    // packages/web/server/lib/relay/signing-key.js and identity.js
    'relaySigningKey',
    'relayEncryptionKey',
    // packages/web/server/lib/notifications/push-runtime.js and apns-runtime.js
    'vapidKeys',
    'publicOrigin',
    'apnsConfig',
  ]),
);

/**
 * The keys MittrCraft 1.22 added to `settings.json` that upstream does not
 * read: the agent Chrome and computer tools and the voice assistant limits.
 * Taken from the 1.22 settings writers (`settings-helpers.js`,
 * `mittrcraft-control/chrome-approvals.js` and `service.js`) less every key
 * upstream 2.1.1 or the upstream release 1.x was built on mentions. Only
 * these move under `mittr`; every other key stays where upstream may read it.
 */
export const MITTR_SETTINGS_KEYS = Object.freeze(
  new Set([
    'agentChromeApprovedHosts',
    'agentChromeHeaded',
    'agentChromeProfile',
    'agentChromeToolEnabled',
    'agentComputerToolEnabled',
    'voiceReplyMaxChars',
    'voiceStepCap',
  ]),
);

const SETTINGS_FILE = 'settings.json';
const MARKER_FILE = '.pre-2x-settings-done';
const PARKED = 'mittr';
const CARRIED_DICTATION = Object.freeze({ key: 'sttProvider', value: 'mittr' });

// 1.x renamed upstream's names to its own; reversing the spelling gives the
// name upstream reads.
const SPELLINGS = [
  ['mittrcraft', 'openchamber'],
  ['MittrCraft', 'OpenChamber'],
  ['Mittrcraft', 'Openchamber'],
  ['MITTRCRAFT', 'OPENCHAMBER'],
];
const upstreamNameOf = (key) => SPELLINGS.reduce((name, [ours, theirs]) => name.split(ours).join(theirs), key);

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

const convert = (settings, { upstreamKeys, mittrKeys }) => {
  const next = {};
  const parked = isPlainObject(settings[PARKED]) ? { ...settings[PARKED] } : {};
  const renames = {};
  const renamed = [];
  const moved = [];
  for (const [key, value] of Object.entries(settings)) {
    if (key === PARKED && isPlainObject(value)) continue;
    if (key === CARRIED_DICTATION.key && value === CARRIED_DICTATION.value) {
      parked[key] = value;
      moved.push(key);
      continue;
    }
    const upstreamName = upstreamNameOf(key);
    if (!upstreamKeys.has(key) && upstreamName !== key && upstreamKeys.has(upstreamName)) {
      renames[upstreamName] = value;
      renamed.push(key);
      continue;
    }
    if (mittrKeys.has(key) && !upstreamKeys.has(key)) {
      parked[key] = value;
      moved.push(key);
      continue;
    }
    next[key] = value;
  }
  // The value 1.x actually used wins; a value already under the upstream name
  // is kept under `mittr` rather than dropped.
  for (const [upstreamName, value] of Object.entries(renames)) {
    if (Object.hasOwn(next, upstreamName)) {
      parked[upstreamName] = next[upstreamName];
      moved.push(upstreamName);
    }
    next[upstreamName] = value;
  }
  if (Object.keys(parked).length > 0) next[PARKED] = parked;
  return { next, renamed, moved };
};

/**
 * Brings a 1.x `settings.json` to the names upstream reads, once per data
 * dir. A key with a MittrCraft spelling of an upstream name gets the upstream
 * name; a listed MittrCraft-only key moves under `mittr`, where upstream
 * leaves it alone; every other key stays at the top level. Rejects without
 * marking when the file cannot be read or written, so the next start tries
 * again.
 *
 * Renamed keys never need the same rename in `preferences.json`: upstream
 * seeds that file only with registry keys of `profile` scope, and no registry
 * key has an OpenChamber spelling (pinned in `settings.test.js`).
 *
 * The write is atomic but does not take upstream's settings lock, which the
 * plugin context does not expose; it runs once, during server setup.
 */
export const migrateSettingsOnce = async ({ dataDir, upstreamKeys, mittrKeys }) => {
  const marker = path.join(dataDir, MARKER_FILE);
  const nothing = { renamed: [], moved: [] };
  if (await exists(marker)) return nothing;

  const file = path.join(dataDir, SETTINGS_FILE);
  const settings = await readSettings(file);
  const result = settings ? convert(settings, { upstreamKeys, mittrKeys }) : null;
  if (result && (result.renamed.length > 0 || result.moved.length > 0)) {
    await writeSettings(file, result.next);
  }

  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(marker, `${new Date().toISOString()}\n`);
  return result ? { renamed: result.renamed, moved: result.moved } : nothing;
};

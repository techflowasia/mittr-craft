import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { writePrivateAtomic } from './private-file.js';
import { isPlainObject } from './values.js';

const SETTINGS_FILE = 'mittr-settings.json';
const UPSTREAM_SETTINGS_FILE = 'settings.json';
const PARKED = 'mittr';
const HOST = /^[a-z0-9.-]+$/;
const BRACKETED = /^\[([0-9a-f:.]+)\]$/;
const INVALID_SWITCH = 'showOtherProviders must be true or false';

const PARKED_TOOL_KEYS = Object.freeze({
  agentComputerToolEnabled: 'computer',
  agentChromeToolEnabled: 'chrome',
  agentChromeProfile: 'chromeProfile',
  agentChromeHeaded: 'chromeHeaded',
  agentChromeApprovedHosts: 'chromeApprovedHosts',
});

const NOT_IN_PROFILE_NAME = /[/\\~\0]/;
const DOT_NAMES = new Set(['.', '..']);

const isBoolean = (value) => value === true || value === false;
const isText = (value) => value === String(value);
const hostOf = (value) => (isText(value) ? value.trim().toLowerCase() : '');
const isPageIPv6 = (host) => {
  const inner = BRACKETED.exec(host)?.[1];
  if (!inner || !net.isIPv6(inner)) return false;
  try {
    return new URL(`http://${host}/`).hostname === host;
  } catch {
    return false;
  }
};
export const isHost = (value) => {
  const host = hostOf(value);
  return HOST.test(host) || isPageIPv6(host);
};
export const profileOf = (value) => {
  const name = isText(value) ? value.trim() : '';
  return name && !name.startsWith('-') && !NOT_IN_PROFILE_NAME.test(name) && !DOT_NAMES.has(name) ? name : null;
};

const TOOL_FIELDS = Object.freeze({
  computer: isBoolean,
  chrome: isBoolean,
  chromeHeaded: isBoolean,
  chromeProfile: (value) => value === null || profileOf(value) !== null,
  chromeApprovedHosts: (value) => Array.isArray(value) && value.every(isHost),
});

const hostsOf = (value) => (Array.isArray(value) ? [...new Set(value.filter(isHost).map(hostOf))] : []);

const toolsOf = (stored) => {
  const tools = isPlainObject(stored) ? stored : {};
  return {
    computer: tools.computer !== false,
    chrome: tools.chrome !== false,
    chromeProfile: profileOf(tools.chromeProfile),
    chromeHeaded: tools.chromeHeaded === true,
    chromeApprovedHosts: hostsOf(tools.chromeApprovedHosts),
  };
};

const settingsOf = (stored) => ({ showOtherProviders: stored.showOtherProviders === true, tools: toolsOf(stored.tools) });

const checkToolPatch = (patch) => {
  if (!isPlainObject(patch)) throw new TypeError('tools must be an object of tool settings');
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(TOOL_FIELDS, key) || !TOOL_FIELDS[key](value)) throw new TypeError(`Unknown or invalid tool setting: ${key}`);
  }
};

const checkPatch = (patch) => {
  if (!isPlainObject(patch) || (!Object.hasOwn(patch, 'showOtherProviders') && !Object.hasOwn(patch, 'tools'))) {
    throw new TypeError(`${INVALID_SWITCH}, or tools must be given`);
  }
  if (Object.hasOwn(patch, 'showOtherProviders') && !isBoolean(patch.showOtherProviders)) throw new TypeError(INVALID_SWITCH);
  if (Object.hasOwn(patch, 'tools')) checkToolPatch(patch.tools);
};

const storedFieldsOf = (stored) => {
  const fields = {};
  if (Object.hasOwn(stored, 'showOtherProviders')) fields.showOtherProviders = stored.showOtherProviders === true;
  if (Object.hasOwn(stored, 'tools')) fields.tools = toolsOf(stored.tools);
  return fields;
};

/**
 * MittrCraft's own settings, `<dataDir>/mittr-settings.json`, kept apart from
 * upstream's settings.json, whose allowlist drops keys it does not know (R44).
 *
 * Reading fails closed: a missing file, one that cannot be read or parsed, or
 * a value that is not exactly `true` all read as the defaults, which keep the
 * engine locked to Mittr. A damaged file is reported once.
 *
 * `update(patch)` takes an explicit true or false, a tools patch, or both,
 * and returns what it stored. Updates run one at a time, each on what the one
 * before it stored, and each writes a private (0600) temp file and renames it
 * over the old one, so a reader never sees half a file. A damaged file is
 * replaced.
 */
export function createMittrSettings({ dataDir, logger = console }) {
  const filePath = path.join(dataDir, SETTINGS_FILE);
  let warned = false;

  const readStored = async () => {
    let stored;
    try {
      stored = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT' && !warned) {
        warned = true;
        logger.warn(`[mittr] ${filePath} cannot be read; other providers stay hidden:`, error?.message ?? error);
      }
      return {};
    }
    return isPlainObject(stored) ? stored : {};
  };

  const read = async () => settingsOf(await readStored());

  const write = async (settings) => {
    await fs.mkdir(dataDir, { recursive: true });
    writePrivateAtomic(filePath, `${JSON.stringify(settings, null, 2)}\n`);
  };

  let updating = Promise.resolve();
  const queued = (work) => {
    const done = updating.then(work);
    updating = done.catch(() => {});
    return done;
  };

  const update = (patch) => queued(async () => {
    checkPatch(patch);
    const next = storedFieldsOf(await readStored());
    if (Object.hasOwn(patch, 'showOtherProviders')) next.showOtherProviders = patch.showOtherProviders;
    if (Object.hasOwn(patch, 'tools')) next.tools = toolsOf({ ...toolsOf(next.tools), ...patch.tools });
    await write(next);
    return settingsOf(next);
  });

  const readParked = async () => {
    let settings;
    try {
      settings = JSON.parse(await fs.readFile(path.join(dataDir, UPSTREAM_SETTINGS_FILE), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
    return isPlainObject(settings?.[PARKED]) ? settings[PARKED] : {};
  };

  const carryParkedToolSettings = () => queued(async () => {
    const stored = await readStored();
    if (Object.hasOwn(stored, 'tools')) return null;
    const parked = await readParked();
    const carried = Object.entries(PARKED_TOOL_KEYS).filter(([key]) => Object.hasOwn(parked, key));
    if (carried.length === 0) return null;
    const tools = toolsOf(Object.fromEntries(carried.map(([key, field]) => [field, parked[key]])));
    await write({ ...storedFieldsOf(stored), tools });
    return tools;
  });

  return { read, update, carryParkedToolSettings };
}

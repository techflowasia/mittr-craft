import fs from 'node:fs/promises';
import path from 'node:path';

import { writePrivateAtomic } from './private-file.js';

const SETTINGS_FILE = 'mittr-settings.json';
const DEFAULTS = Object.freeze({ showOtherProviders: false });

/**
 * MittrCraft's own settings, `<dataDir>/mittr-settings.json`, kept apart from
 * upstream's settings.json, whose allowlist drops keys it does not know (R44).
 *
 * Reading fails closed: a missing file, one that cannot be read or parsed, or
 * a value that is not exactly `true` all read as the defaults, which keep the
 * engine locked to Mittr. A damaged file is reported once.
 *
 * `update(patch)` takes an explicit true or false and returns what it stored.
 * Updates run one at a time, each on what the one before it stored, and each
 * writes a private (0600) temp file and renames it over the old one, so a
 * reader never sees half a file. A damaged file is replaced.
 */
export function createMittrSettings({ dataDir, logger = console }) {
  const filePath = path.join(dataDir, SETTINGS_FILE);
  let warned = false;

  const read = async () => {
    let stored;
    try {
      stored = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT' && !warned) {
        warned = true;
        logger.warn(`[mittr] ${filePath} cannot be read; other providers stay hidden:`, error?.message ?? error);
      }
      return { ...DEFAULTS };
    }
    return { showOtherProviders: stored?.showOtherProviders === true };
  };

  const write = async (settings) => {
    await fs.mkdir(dataDir, { recursive: true });
    writePrivateAtomic(filePath, `${JSON.stringify(settings, null, 2)}\n`);
  };

  let updating = Promise.resolve();
  const update = (patch) => {
    const updated = updating.then(async () => {
      const showOtherProviders = patch?.showOtherProviders;
      if (showOtherProviders !== true && showOtherProviders !== false) {
        throw new TypeError('showOtherProviders must be true or false');
      }
      const next = { ...(await read()), showOtherProviders };
      await write(next);
      return { ...next };
    });
    updating = updated.catch(() => {});
    return updated;
  };

  return { read, update };
}

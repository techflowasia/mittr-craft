import fs from 'node:fs/promises';
import path from 'node:path';

const SETTINGS_FILE = 'mittr-settings.json';
const DEFAULTS = Object.freeze({ showOtherProviders: false });

/**
 * MittrCraft's own settings, `<dataDir>/mittr-settings.json`, kept apart from
 * upstream's settings.json, whose allowlist drops keys it does not know (R44).
 *
 * Reading fails closed: a missing file, one that cannot be read or parsed, or
 * a value that is not exactly `true` all read as the defaults, which keep the
 * engine locked to Mittr. A damaged file is reported once.
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

  return { read };
}

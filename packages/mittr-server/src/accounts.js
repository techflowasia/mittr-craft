import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads the account index MittrCraft 1.x writes at
 * `<dataDir>/mittr-accounts/index.json`:
 * `{ active: userId | null, accounts: [{ userId, displayName, home, signedIn }] }`.
 * The first account on a machine has `home: null` and uses the shared engine
 * folders; each later one gets a 16-hex `home` of its own.
 */

const INDEX_FILE = path.join('mittr-accounts', 'index.json');
const ACCOUNT_HOME = /^[0-9a-f]{16}$/;

// A JSON object, as opposed to an array, a primitive or null.
const isJsonObject = (value) => value != null && Object.getPrototypeOf(value) === Object.prototype;

/**
 * The engine account home of the signed-in active account, or null for the
 * shared folders. A missing, unreadable or malformed index means the shared
 * folders too, as it did in 1.x; only an index that exists but cannot be read
 * is worth a warning.
 */
export const activeAccountHome = (dataDir, { logger = console } = {}) => {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dataDir, INDEX_FILE), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') logger.warn('[mittr] could not read the account index:', error?.message ?? error);
    return null;
  }

  let index;
  try {
    index = JSON.parse(raw);
  } catch (error) {
    logger.warn('[mittr] the account index is not valid JSON; using the shared engine folders:', error.message);
    return null;
  }
  if (!isJsonObject(index) || !Array.isArray(index.accounts) || !index.active) return null;

  const active = index.accounts.find(
    (entry) => isJsonObject(entry) && entry.userId === index.active && entry.signedIn === true,
  );
  return ACCOUNT_HOME.exec(active?.home)?.[0] ?? null;
};

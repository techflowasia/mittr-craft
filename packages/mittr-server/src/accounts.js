import fs from 'node:fs';

import { accountIndexPath, parseAccountIndex } from './mittr/account-store.js';

/**
 * The engine account home of the signed-in active account, or null for the
 * shared folders, read from the index the account store keeps (and 1.x wrote)
 * through that store's own parser, with the store's rule for a damaged index.
 * A missing, unreadable or damaged index means the shared folders, as it did
 * in 1.x; only an index that exists but cannot be used is worth a warning.
 */
export const activeAccountHome = (dataDir, { logger = console } = {}) => {
  let raw;
  try {
    raw = fs.readFileSync(accountIndexPath(dataDir), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') logger.warn('[mittr] could not read the account index:', error?.message ?? error);
    return null;
  }

  let index;
  try {
    index = parseAccountIndex(raw, { strict: true });
  } catch (error) {
    logger.warn('[mittr] the account index is damaged; using the shared engine folders:', error.message);
    return null;
  }
  return index.accounts.find((entry) => entry.userId === index.active)?.home ?? null;
};

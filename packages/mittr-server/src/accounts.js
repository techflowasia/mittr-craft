import fs from 'node:fs';
import path from 'node:path';

import { NO_ACCOUNT_HOME } from './engine-home.js';
import { accountIndexPath, parseAccountIndex } from './mittr/account-store.js';

const LEGACY_SESSION_FILE = 'mittr-session';

/**
 * The engine account home of the signed-in active account, or null for the
 * shared folders, read from the index the account store keeps (and 1.x wrote)
 * through that store's own parser, with the store's rule for a damaged index.
 * With no account active it is the empty neutral home, unless a 1.x single
 * session is still waiting to become the first account; only an index that
 * exists but cannot be used is worth a warning.
 */
export const activeAccountHome = (dataDir, { logger = console } = {}) => {
  const legacyWaiting = () => fs.existsSync(path.join(dataDir, LEGACY_SESSION_FILE));
  let raw;
  try {
    raw = fs.readFileSync(accountIndexPath(dataDir), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return legacyWaiting() ? null : NO_ACCOUNT_HOME;
    logger.warn('[mittr] could not read the account index:', error?.message ?? error);
    return NO_ACCOUNT_HOME;
  }

  let index;
  try {
    index = parseAccountIndex(raw, { strict: true });
  } catch (error) {
    logger.warn('[mittr] the account index is damaged; using an empty engine home:', error.message);
    return NO_ACCOUNT_HOME;
  }
  const active = index.accounts.find((entry) => entry.userId === index.active);
  if (active) return active.home;
  return index.accounts.length === 0 && legacyWaiting() ? null : NO_ACCOUNT_HOME;
};

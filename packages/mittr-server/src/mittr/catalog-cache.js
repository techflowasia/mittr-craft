import { randomBytes } from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';

import { CATALOG_COLLECTIONS } from './catalog.js';

const ACCOUNT_HOME = /^[0-9a-f]{16}$/;
const PRIVATE = 0o600;
const NOT_A_CATALOG = 'unexpected shape';

const reasonOf = (error) => {
  if (error instanceof SyntaxError) return 'not valid JSON';
  if (error?.message === NOT_A_CATALOG) return NOT_A_CATALOG;
  return `cannot be read${error?.code ? ` (${error.code})` : ''}`;
};

/**
 * Where an account's last catalog is kept, as 1.22 named it: the account on
 * the shared engine history (`home: null`) at `<dataDir>/mittr-catalog.json`,
 * every other one at `<dataDir>/mittr-accounts/<home>.catalog.json`.
 */
export const catalogCachePath = (dataDir, home) => {
  if (home === null) return path.join(dataDir, 'mittr-catalog.json');
  if (typeof home !== 'string' || !ACCOUNT_HOME.test(home)) throw new Error('A catalog cache needs an account home key');
  return path.join(dataDir, 'mittr-accounts', `${home}.catalog.json`);
};

const isCollection = (value) => value !== null && typeof value === 'object'
  && typeof value.configured === 'boolean' && Array.isArray(value.items);

const isCachedCatalog = (value) => value !== null && typeof value === 'object'
  && Number.isInteger(value.bundleVersion)
  && CATALOG_COLLECTIONS.every((name) => isCollection(value[name]));

/**
 * The last catalog Mittr sent one account, so its models survive a network
 * blip or an offline start. It does not make Mittr work offline: without the
 * platform there is no token to call a model with.
 *
 * The catalog is company data: the file is private to the owner and written
 * beside the target, then renamed over it, so a crash leaves the old one
 * whole. `read()` answers null when nothing usable is cached; a file that
 * exists but cannot be used warns once.
 */
export function createCatalogCache({ filePath, logger = console, fs = nodeFs }) {
  let warned = false;

  const read = () => {
    let value;
    try {
      value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!isCachedCatalog(value)) throw new Error(NOT_A_CATALOG);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      // A fixed reason, never the parser's message, which can quote the file.
      if (!warned) logger.warn(`[mittr] ignoring the Mittr catalog cache at ${filePath}: ${reasonOf(error)}`);
      warned = true;
      return null;
    }
    return value;
  };

  const write = (catalog) => {
    const text = JSON.stringify(catalog, null, 2);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: PRIVATE });
      if (process.platform !== 'win32') fs.chmodSync(temporary, PRIVATE);
      fs.renameSync(temporary, filePath);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
    warned = false;
  };

  return { read, write };
}

import nodeFs from 'node:fs';
import path from 'node:path';

// The cache keeps configuration from disappearing while the network blips. It
// does not make the product work offline: without the broker there is no
// credential to call a model with (spec §7).
export function createCatalogCache({ filePath, fsImpl = nodeFs }) {
  const read = () => {
    try {
      return JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    } catch {
      // A cache that cannot be parsed is a cache we do not have. Throwing here
      // would take the whole server down at startup over a truncated file.
      return null;
    }
  };

  const write = (catalog) => {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(filePath, JSON.stringify(catalog, null, 2), 'utf8');
  };

  return { read, write };
}

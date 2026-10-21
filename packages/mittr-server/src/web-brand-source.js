import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(here, '..', '..', '..');
export const WEB_BRAND_FILE = path.join(here, 'web-brand.json');
export const WEB_BRAND_COMMAND = 'node scripts/mittr/generate-web-brand.mjs';

const WEB_DIST = 'resources/web-dist/';
const PWA_ROUTES = '.product/web/server/lib/opencode/pwa-manifest-routes.js';
const PWA_NAME_MARKER = 'const DEFAULT_PWA_APP_NAME';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const quoted = (text) => {
  const match = /'([^']*)'/.exec(text);
  if (!match) throw new Error(`no quoted value in ${JSON.stringify(text)}`);
  return match[1];
};

export const generateWebBrand = ({ brandDir = 'brand' } = {}) => {
  const dir = path.resolve(REPO_ROOT, brandDir);
  const strings = [...readJson(path.join(dir, 'visible-strings.json')), ...readJson(path.join(dir, 'visible-strings.prod.json'))];
  const files = strings
    .filter((entry) => entry.file.startsWith(WEB_DIST))
    .map((entry) => ({ ...entry, file: entry.file.slice(WEB_DIST.length) }));
  const pwa = strings.filter((entry) => entry.file === PWA_ROUTES);
  const name = pwa.find((entry) => entry.from.startsWith(PWA_NAME_MARKER));
  const description = pwa.find((entry) => !entry.from.startsWith(PWA_NAME_MARKER));
  if (pwa.length !== 2 || !name || !description) throw new Error(`${PWA_ROUTES} needs exactly one name entry and one description entry`);
  return {
    files,
    manifest: {
      name: { from: quoted(name.from), to: quoted(name.to) },
      description: { from: quoted(description.from), to: quoted(description.to) },
    },
  };
};

export const serializeWebBrand = (brand) => `${JSON.stringify(brand, null, 2)}\n`;

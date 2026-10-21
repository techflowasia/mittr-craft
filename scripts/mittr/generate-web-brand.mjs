import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { WEB_BRAND_FILE, generateWebBrand, serializeWebBrand } from '../../packages/mittr-server/src/web-brand-source.js';

export { generateWebBrand };

export const writeWebBrand = ({ brandDir = 'brand', file = WEB_BRAND_FILE } = {}) => {
  fs.writeFileSync(file, serializeWebBrand(generateWebBrand({ brandDir })));
  return file;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  console.log(`wrote ${writeWebBrand()}`);
}

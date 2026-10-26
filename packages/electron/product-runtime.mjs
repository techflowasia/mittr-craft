// The product resolved for this process. It reads `product.json` once at import
// and applies its environment and directories right away, so import it before
// any module that reads those variables.

import { app } from 'electron';

import { applyProductEnv, ensureProductDirs, readProduct, serverVersionEnv } from './product.mjs';

export const PRODUCT = readProduct({ appPath: app.getAppPath() });

applyProductEnv(PRODUCT);
Object.assign(process.env, serverVersionEnv(PRODUCT, app.getVersion()));
if (PRODUCT.serverPlugins.length > 0) {
  process.env.OPENCHAMBER_SERVER_PLUGINS = JSON.stringify(PRODUCT.serverPlugins);
}
ensureProductDirs(PRODUCT);

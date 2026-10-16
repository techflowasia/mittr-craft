import fs from 'node:fs/promises';
import path from 'node:path';

// A relative path on purpose: Bun links no workspace package into the root
// node_modules, and the server plugin bundle inlines this module.
import { identityPluginSource } from '../../../mittr-opencode/src/identity-plugin.js';

const PRODUCT_NAME = 'MittrCraft';
const PLUGIN_DIR = path.join('engine-plugins', 'mittrcraft-identity');
const MANIFEST = `${JSON.stringify({ type: 'module', exports: { '.': './index.js' } }, null, 2)}\n`;

// Temp + rename, so an engine reloading its plugins never reads half a file;
// the mode is set again because a rename keeps whatever an old file had.
const writePrivate = async (file, text) => {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
};

/**
 * Writes the identity plugin under `<dataDir>/engine-plugins/` and returns
 * its directory. The engine cannot read inside `app.asar`, so, as upstream
 * does for its agent tool, the source lives in the data dir.
 */
export const materializeIdentityPlugin = async ({ dataDir }) => {
  const dir = path.join(dataDir, PLUGIN_DIR);
  await fs.mkdir(dir, { recursive: true });
  await writePrivate(path.join(dir, 'package.json'), MANIFEST);
  await writePrivate(path.join(dir, 'index.js'), identityPluginSource({ productName: PRODUCT_NAME }));
  return dir;
};

/** The managed-config share that loads the plugin. */
export const identityFragment = (dir) => ({ plugins: [dir] });

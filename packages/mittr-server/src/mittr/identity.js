import fs from 'node:fs/promises';
import path from 'node:path';

// A relative path on purpose: Bun links no workspace package into the root
// node_modules, and the server plugin bundle inlines this module.
import { identityPluginSource } from '../../../mittr-opencode/src/identity-plugin.js';
import { writePrivateAtomic } from './private-file.js';

const PRODUCT_NAME = 'MittrCraft';
const PLUGIN_DIR = path.join('engine-plugins', 'mittrcraft-identity');
const MANIFEST = `${JSON.stringify({ type: 'module', exports: { '.': './index.js' } }, null, 2)}\n`;

const readIfPresent = (file) => fs.readFile(file, 'utf8').catch((error) => {
  if (error?.code === 'ENOENT') return null;
  throw error;
});

// A file that already says the same is only brought back to 0600, so its
// mtime stays put across builds. Otherwise temp + rename, so an engine
// reloading its plugins never reads half a file; each temp name is unique,
// so two builds writing at once never rename each other's file away.
const writePrivate = async (file, text) => {
  if (await readIfPresent(file) === text) {
    await fs.chmod(file, 0o600);
    return;
  }
  writePrivateAtomic(file, text);
};

/** Where the identity plugin lives in the data dir. */
export const identityPluginDir = (dataDir) => path.join(dataDir, PLUGIN_DIR);

/**
 * Writes the identity plugin under `<dataDir>/engine-plugins/` and returns
 * its directory. The engine cannot read inside `app.asar`, so, as upstream
 * does for its agent tool, the source lives in the data dir.
 */
export const materializeIdentityPlugin = async ({ dataDir }) => {
  const dir = identityPluginDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  await writePrivate(path.join(dir, 'package.json'), MANIFEST);
  await writePrivate(path.join(dir, 'index.js'), identityPluginSource({ productName: PRODUCT_NAME }));
  return dir;
};

/** The managed-config share that loads the plugin. */
export const identityFragment = (dir) => ({ plugins: [dir] });

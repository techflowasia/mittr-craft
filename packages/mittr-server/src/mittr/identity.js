import path from 'node:path';

import { identityPluginSource } from './identity-plugin.js';
import { writeEnginePlugin } from './private-file.js';

const PRODUCT_NAME = 'MittrCraft';
const PLUGIN_DIR = path.join('engine-plugins', 'mittrcraft-identity');

/** Where the identity plugin lives in the data dir. */
export const identityPluginDir = (dataDir) => path.join(dataDir, PLUGIN_DIR);

/**
 * Writes the identity plugin under `<dataDir>/engine-plugins/` and returns
 * its directory. The engine cannot read inside `app.asar`, so, as upstream
 * does for its agent tool, the source lives in the data dir.
 */
export const materializeIdentityPlugin = ({ dataDir }) => writeEnginePlugin(identityPluginDir(dataDir), identityPluginSource({ productName: PRODUCT_NAME }));

/** The managed-config share that loads the plugin. */
export const identityFragment = (dir) => ({ plugins: [dir] });

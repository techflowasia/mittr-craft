import fs from 'node:fs';
import path from 'node:path';

import { bundledEngineDirs, runsBundledEngine } from '../engine-import.js';

const LEFT_OUT_FILE = 'left-out.json';
const PLUGIN_ID = /^opencode\.provider\.[a-z-]+$/;

export const engineLeftOutFragment = ({ env, resourcesDir = null, logger }) => {
  if (!runsBundledEngine({ env, resourcesDir })) return {};
  for (const dir of bundledEngineDirs({ env, resourcesDir })) {
    try {
      const { plugins } = JSON.parse(fs.readFileSync(path.join(dir, LEFT_OUT_FILE), 'utf8'));
      const ids = plugins.filter((id) => PLUGIN_ID.test(id));
      return ids.length > 0 ? { plugins: ids.map((id) => `-${id}`) } : {};
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn('[mittr] could not read what the engine was built without:', error?.message ?? error);
    }
  }
  return {};
};

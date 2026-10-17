#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { prepareCliEnvironment, readProductEnv } from '../src/cli-env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_CLI = path.resolve(here, '..', '..', 'web', 'bin', 'cli.js');
const PLUGIN = path.resolve(here, '..', 'src', 'plugin.js');
const PRODUCT = path.resolve(here, '..', '..', '..', 'brand', 'product.prod.json');

const { env, refusal } = prepareCliEnvironment({
  env: process.env,
  homeDir: os.homedir(),
  pluginPath: PLUGIN,
  productEnv: readProductEnv(PRODUCT),
});
if (refusal) {
  console.error(refusal);
  process.exit(1);
}
Object.assign(process.env, env);

process.argv[1] = SERVER_CLI;
await import(pathToFileURL(SERVER_CLI).href);

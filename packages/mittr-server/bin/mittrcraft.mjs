#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { prepareCliEnvironment, readProductEnv, RIPGREP_DOWNLOAD_NOTICE, RIPGREP_MISSING_MESSAGE, startsServer } from '../src/cli-env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_CLI = path.resolve(here, '..', '..', 'web', 'bin', 'cli.js');
const PLUGIN = path.resolve(here, '..', 'src', 'plugin.js');
const PRODUCT = path.resolve(here, 'product-env.json');

const { env, refusal, ripgrep } = prepareCliEnvironment({
  env: process.env,
  homeDir: os.homedir(),
  pluginPath: PLUGIN,
  productEnv: readProductEnv(PRODUCT),
  packageDir: path.resolve(here, '..'),
});
if (refusal) {
  console.error(refusal);
  process.exit(1);
}
if (startsServer(process.argv.slice(2)) && !ripgrep.found) {
  if (!ripgrep.downloadAllowed) {
    console.error(RIPGREP_MISSING_MESSAGE);
    process.exit(1);
  }
  console.error(RIPGREP_DOWNLOAD_NOTICE);
}
Object.assign(process.env, env);

process.argv[1] = SERVER_CLI;
await import(pathToFileURL(SERVER_CLI).href);

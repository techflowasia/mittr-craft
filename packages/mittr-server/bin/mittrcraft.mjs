#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVER_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'bin', 'cli.js');

process.argv[1] = SERVER_CLI;
await import(pathToFileURL(SERVER_CLI).href);

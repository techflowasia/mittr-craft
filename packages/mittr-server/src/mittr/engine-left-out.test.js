import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { engineLeftOutFragment } from './engine-left-out.js';

const resources = (t, text = JSON.stringify({ plugins: ['opencode.provider.some-agent'] })) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-left-out-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'opencode-server'));
  fs.writeFileSync(path.join(dir, 'opencode-server', 'serve.mjs'), '');
  if (text !== null) fs.writeFileSync(path.join(dir, 'opencode-server', 'left-out.json'), text);
  return dir;
};
const logger = () => { const lines = []; return { lines, warn: (...args) => lines.push(args.join(' ')) }; };

test('a provider whose code the app leaves out is switched off in the bundled engine', (t) => {
  const resourcesDir = resources(t);
  const off = { plugins: ['-opencode.provider.some-agent'] };
  assert.deepEqual(engineLeftOutFragment({ env: {}, resourcesDir, logger: logger() }), off);
  assert.deepEqual(engineLeftOutFragment({ env: { OPENCODE_BINARY: path.join(resourcesDir, 'opencode-server', 'serve.mjs') }, resourcesDir, logger: logger() }), off);
  assert.deepEqual(engineLeftOutFragment({ env: { OPENCHAMBER_BUNDLED_OPENCODE_SERVER_DIR: path.join(resourcesDir, 'opencode-server') }, logger: logger() }), off);
});

test('another engine, a build without a list and a damaged list switch nothing off', (t) => {
  const own = path.join(resources(t), 'own-engine');
  fs.writeFileSync(own, 'x');
  assert.deepEqual(engineLeftOutFragment({ env: { OPENCODE_BINARY: own }, resourcesDir: resources(t), logger: logger() }), {});
  assert.deepEqual(engineLeftOutFragment({ env: {}, resourcesDir: resources(t, null), logger: logger() }), {});
  assert.deepEqual(engineLeftOutFragment({ env: {}, resourcesDir: null, logger: logger() }), {});
  const log = logger();
  assert.deepEqual(engineLeftOutFragment({ env: {}, resourcesDir: resources(t, '{'), logger: log }), {});
  assert.equal(log.lines.length, 1);
  assert.deepEqual(engineLeftOutFragment({ env: {}, resourcesDir: resources(t, JSON.stringify({ plugins: ['*', 'opencode.tool.todo'] })), logger: logger() }), {});
});

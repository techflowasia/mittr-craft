import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { identityFragment, materializeIdentityPlugin } from './identity.js';
import { tempDataDir } from './test-helpers.js';

const modeOf = (file) => fs.statSync(file).mode & 0o777;

test('materializeIdentityPlugin writes a loadable directory plugin', async (t) => {
  const dataDir = tempDataDir(t);
  const dir = await materializeIdentityPlugin({ dataDir });

  assert.equal(dir, path.join(dataDir, 'engine-plugins', 'mittrcraft-identity'));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.deepEqual(manifest, { type: 'module', exports: { '.': './index.js' } });
  if (process.platform !== 'win32') {
    assert.equal(modeOf(path.join(dir, 'package.json')), 0o600);
    assert.equal(modeOf(path.join(dir, 'index.js')), 0o600);
  }

  const plugin = (await import(pathToFileURL(path.join(dir, 'index.js')).href)).default;
  assert.equal(plugin.id, 'mittrcraft.identity');
  const hooks = new Map();
  await plugin.setup({ session: { hook: async (name, handler) => { hooks.set(name, handler); } } });
  const o = { system: [{ type: 'text', text: 'You are an AI agent running in OpenCode, a coding agent harness. Help.' }] };
  hooks.get('context')(o);
  assert.equal(o.system[0].text, 'You are MittrCraft, an AI coding agent. Help.');
});

test('a second write replaces the files and tightens a loosened mode', async (t) => {
  const dataDir = tempDataDir(t);
  const dir = await materializeIdentityPlugin({ dataDir });
  fs.writeFileSync(path.join(dir, 'index.js'), 'stale');
  fs.chmodSync(path.join(dir, 'index.js'), 0o644);

  assert.equal(await materializeIdentityPlugin({ dataDir }), dir);
  assert.ok(fs.readFileSync(path.join(dir, 'index.js'), 'utf8').includes('mittrcraft.identity'));
  if (process.platform !== 'win32') assert.equal(modeOf(path.join(dir, 'index.js')), 0o600);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['index.js', 'package.json']);
});

test('identityFragment lists the plugin directory', () => {
  assert.deepEqual(identityFragment('/data/engine-plugins/mittrcraft-identity'), { plugins: ['/data/engine-plugins/mittrcraft-identity'] });
});

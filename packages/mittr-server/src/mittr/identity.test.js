import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { identityFragment, identityPluginDir, materializeIdentityPlugin } from './identity.js';
import { tempDataDir } from './test-helpers.js';

const modeOf = (file) => fs.statSync(file).mode & 0o777;

test('materializeIdentityPlugin writes a loadable directory plugin', async (t) => {
  const dataDir = tempDataDir(t);
  const dir = await materializeIdentityPlugin({ dataDir });

  assert.equal(dir, path.join(dataDir, 'engine-plugins', 'mittrcraft-identity'));
  assert.equal(identityPluginDir(dataDir), dir);
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

test('a build that finds the same plugin on disk leaves the files alone', async (t) => {
  const dataDir = tempDataDir(t);
  const dir = await materializeIdentityPlugin({ dataDir });
  const past = new Date('2026-01-01T00:00:00Z');
  for (const name of ['index.js', 'package.json']) fs.utimesSync(path.join(dir, name), past, past);

  await materializeIdentityPlugin({ dataDir });

  for (const name of ['index.js', 'package.json']) {
    assert.equal(fs.statSync(path.join(dir, name)).mtimeMs, past.getTime(), `${name} was written again`);
  }
});

test('an unchanged plugin with a loosened mode is tightened without a rewrite', { skip: process.platform === 'win32' }, async (t) => {
  const dataDir = tempDataDir(t);
  const dir = await materializeIdentityPlugin({ dataDir });
  const past = new Date('2026-01-01T00:00:00Z');
  fs.chmodSync(path.join(dir, 'index.js'), 0o644);
  fs.utimesSync(path.join(dir, 'index.js'), past, past);

  await materializeIdentityPlugin({ dataDir });

  assert.equal(modeOf(path.join(dir, 'index.js')), 0o600);
  assert.equal(fs.statSync(path.join(dir, 'index.js')).mtimeMs, past.getTime());
});

test('builds that write at the same moment all succeed and leave one whole plugin', async (t) => {
  const dataDir = tempDataDir(t);
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  t.after(() => { Date.now = realNow; });
  fs.mkdirSync(identityPluginDir(dataDir), { recursive: true });
  fs.writeFileSync(path.join(identityPluginDir(dataDir), 'index.js'), 'stale');

  const dirs = await Promise.all(Array.from({ length: 8 }, () => materializeIdentityPlugin({ dataDir })));

  assert.deepEqual(new Set(dirs), new Set([identityPluginDir(dataDir)]));
  assert.ok(fs.readFileSync(path.join(identityPluginDir(dataDir), 'index.js'), 'utf8').includes('mittrcraft.identity'));
  assert.deepEqual(fs.readdirSync(identityPluginDir(dataDir)).sort(), ['index.js', 'package.json']);
});

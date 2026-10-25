import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  AGENT_TOOL_TOKEN_SLOT,
  ENGINE_CHILD_SECRETS,
  ENGINE_ENV_PLUGIN_ID,
  TOOLS_TOKEN_SLOT,
  engineEnvFragment,
  engineEnvPluginDir,
  materializeEngineEnvPlugin,
} from './engine-env-plugin.js';
import { tempDataDir } from './test-helpers.js';

const SLOTS = [TOOLS_TOKEN_SLOT, AGENT_TOOL_TOKEN_SLOT].map((name) => Symbol.for(name));
const WATCHED = [...ENGINE_CHILD_SECRETS, 'MITTRCRAFT_TOOLS_URL', 'OPENCHAMBER_AGENT_TOOL_URL'];

const isolateEnv = (t) => {
  const env = Object.fromEntries(WATCHED.map((name) => [name, process.env[name]]));
  const slots = SLOTS.map((slot) => globalThis[slot]);
  t.after(() => {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    SLOTS.forEach((slot, at) => {
      if (slots[at] === undefined) delete globalThis[slot];
      else globalThis[slot] = slots[at];
    });
  });
};

const load = async (dir, tag) => (await import(`${pathToFileURL(path.join(dir, 'index.js')).href}?${tag}=${Date.now()}`)).default;

test('the plugin is written privately to its own folder and named in the config', { skip: process.platform === 'win32' }, async (t) => {
  const dataDir = tempDataDir(t);
  const dir = await materializeEngineEnvPlugin({ dataDir });
  assert.equal(dir, engineEnvPluginDir(dataDir));
  assert.equal(dir, path.join(dataDir, 'engine-plugins', ENGINE_ENV_PLUGIN_ID));
  assert.equal(fs.statSync(path.join(dir, 'index.js')).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).exports, { '.': './index.js' });
  const source = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.match(source, /await import\("bun:ffi"\)/, 'the engine copy of the environment is no longer cleared, so native children such as terminals still inherit the secrets');
  assert.ok(source.includes(`for (const name of ${JSON.stringify(ENGINE_CHILD_SECRETS)}) libc.symbols.unsetenv(`), 'not every engine secret is cleared from the engine copy of the environment');
  assert.deepEqual(engineEnvFragment(dir), { plugins: [dir] });
});

test('loading the plugin takes every engine secret out of the environment its processes inherit', async (t) => {
  isolateEnv(t);
  const dataDir = tempDataDir(t);
  const dir = await materializeEngineEnvPlugin({ dataDir });
  for (const name of ENGINE_CHILD_SECRETS) process.env[name] = `acme-${name.toLowerCase()}`;
  process.env.MITTRCRAFT_TOOLS_URL = 'http://127.0.0.1:9/mittr-tools/v1/call';
  process.env.OPENCHAMBER_AGENT_TOOL_URL = 'http://127.0.0.1:9/api/openchamber/agent-tool';

  const plugin = await load(dir, 'first');

  assert.equal(plugin.id, ENGINE_ENV_PLUGIN_ID);
  assert.equal(typeof plugin.setup, 'function');
  assert.deepEqual(ENGINE_CHILD_SECRETS.filter((name) => Object.hasOwn(process.env, name)), []);
  assert.equal(process.env.MITTRCRAFT_TOOLS_URL, 'http://127.0.0.1:9/mittr-tools/v1/call');
  assert.equal(process.env.OPENCHAMBER_AGENT_TOOL_URL, 'http://127.0.0.1:9/api/openchamber/agent-tool');
  assert.equal(globalThis[Symbol.for(TOOLS_TOKEN_SLOT)], 'acme-mittrcraft_tools_token');
  assert.equal(globalThis[Symbol.for(AGENT_TOOL_TOKEN_SLOT)], 'acme-openchamber_agent_tool_token');
});

test('a reload of the plugin keeps the tokens it took the first time', async (t) => {
  isolateEnv(t);
  const dataDir = tempDataDir(t);
  const dir = await materializeEngineEnvPlugin({ dataDir });
  process.env.MITTRCRAFT_TOOLS_TOKEN = 'acme-tools';
  process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = 'acme-agent';
  await load(dir, 'before');
  await load(dir, 'reloaded');

  assert.equal(globalThis[Symbol.for(TOOLS_TOKEN_SLOT)], 'acme-tools');
  assert.equal(globalThis[Symbol.for(AGENT_TOOL_TOKEN_SLOT)], 'acme-agent');
  assert.equal(Object.hasOwn(process.env, 'MITTRCRAFT_TOOLS_TOKEN'), false);
});

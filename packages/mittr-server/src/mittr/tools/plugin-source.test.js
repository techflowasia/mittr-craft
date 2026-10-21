import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { listen, tempDataDir } from '../test-helpers.js';
import { TOOLS_PLUGIN_ID, materializeToolsPlugin, toolsFragment, toolsPluginDir, toolsPluginSource } from './plugin-source.js';

const CHROME = {
  name: 'acme_chrome',
  description: 'Drive a page.',
  parameters: { url: { type: 'string' }, ref: { type: 'string' } },
  definitions: [
    { action: 'chrome.open', title: 'Open a page', description: 'Opens a page.' },
    { action: 'chrome.click', title: 'Click', description: 'Clicks a ref.' },
  ],
};
const COMPUTER = {
  name: 'acme_computer',
  description: 'See the desktop.',
  parameters: { app: { type: 'string' } },
  definitions: [{ action: 'computer.list_apps', title: 'List apps', description: 'Lists apps.' }],
};

const loadPlugin = async (source) => {
  const plugin = (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default;
  const added = [];
  await plugin.setup({ tool: { transform: async (fn) => fn({ add: (tool) => added.push(tool) }) } });
  return { plugin, added };
};

const withConnection = (t, url, token = 'tok-1') => {
  const before = { url: process.env.MITTRCRAFT_TOOLS_URL, token: process.env.MITTRCRAFT_TOOLS_TOKEN };
  process.env.MITTRCRAFT_TOOLS_URL = url;
  process.env.MITTRCRAFT_TOOLS_TOKEN = token;
  t.after(() => {
    for (const [name, value] of [['MITTRCRAFT_TOOLS_URL', before.url], ['MITTRCRAFT_TOOLS_TOKEN', before.token]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
};

const readBody = (req) => new Promise((resolve) => {
  let text = '';
  req.on('data', (chunk) => { text += chunk; });
  req.on('end', () => resolve(text));
});

test('the generated plugin has no import and adds each tool with codemode false', async () => {
  const source = toolsPluginSource({ tools: [CHROME, COMPUTER], codeMode: false });
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.equal(source.split('codemode: false').length - 1, 2);
  assert.equal(source.includes('codemode: true'), false);

  const { plugin, added } = await loadPlugin(source);
  assert.equal(plugin.id, TOOLS_PLUGIN_ID);
  assert.equal(TOOLS_PLUGIN_ID, 'mittrcraft-tools');
  assert.deepEqual(added.map((tool) => [tool.name, tool.description, tool.options]), [
    ['acme_chrome', 'Drive a page.', { codemode: false }],
    ['acme_computer', 'See the desktop.', { codemode: false }],
  ]);
  for (const tool of added) assert.ok(tool.execute instanceof Function);
});

test('Code Mode puts every tool behind the execute tool', async () => {
  const { added } = await loadPlugin(toolsPluginSource({ tools: [CHROME, COMPUTER], codeMode: true }));
  assert.deepEqual(added.map((tool) => tool.options), [{ codemode: true }, { codemode: true }]);
});

test('a tool lists only its own actions and parameters', async () => {
  const { added } = await loadPlugin(toolsPluginSource({ tools: [CHROME, COMPUTER], codeMode: false }));
  const [chrome, computer] = added.map((tool) => tool.input);
  assert.deepEqual(chrome.properties.action.oneOf, [
    { const: 'chrome.open', description: 'Opens a page.' },
    { const: 'chrome.click', description: 'Clicks a ref.' },
  ]);
  assert.equal(Object.hasOwn(chrome.properties.action, 'enum'), false);
  assert.deepEqual(chrome.properties.parameters.properties, CHROME.parameters);
  assert.equal(chrome.properties.parameters.additionalProperties, false);
  assert.deepEqual(chrome.required, ['action']);
  assert.equal(chrome.additionalProperties, true);
  assert.deepEqual(computer.properties.action.oneOf, [{ const: 'computer.list_apps', description: 'Lists apps.' }]);
  assert.deepEqual(computer.properties.parameters.properties, COMPUTER.parameters);
});

test('a call posts the tool, the input and the session with the token, and returns content with MittrCraft metadata, never output', async (t) => {
  const seen = [];
  const base = await listen(t, async (req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(await readBody(req)) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ schemaVersion: 1, ok: true, action: 'chrome.open', data: { url: 'http://a.test/' } }));
  });
  withConnection(t, `${base}/mittr-tools/v1/call`);
  const { added } = await loadPlugin(toolsPluginSource({ tools: [CHROME], codeMode: false }));

  const input = { action: 'open', url: 'http://a.test/', parameters: { url: 'http://b.test/' } };
  const result = await added[0].execute(input, { sessionID: 'ses_1', signal: new AbortController().signal });

  assert.deepEqual(seen.map(({ method, url, body }) => ({ method, url, body })), [{ method: 'POST', url: '/mittr-tools/v1/call', body: { tool: 'acme_chrome', input, sessionID: 'ses_1' } }]);
  assert.equal(seen[0].headers.authorization, 'Bearer tok-1');
  assert.equal(seen[0].headers['content-type'], 'application/json');
  assert.equal(Object.hasOwn(result, 'output'), false);
  assert.deepEqual(JSON.parse(result.content), { schemaVersion: 1, ok: true, action: 'chrome.open', data: { url: 'http://a.test/' } });
  assert.deepEqual(result.metadata, { mittrcraft: { schemaVersion: 1, action: 'chrome.open', description: 'Open a page', ok: true } });
});

test('an answer that is not the envelope, a failed call and a missing connection all come back as a failure envelope', async (t) => {
  const base = await listen(t, (req, res) => {
    res.statusCode = req.url === '/broken' ? 502 : 200;
    res.end(req.url === '/broken' ? 'bad gateway' : JSON.stringify({ schemaVersion: 1, ok: false, action: 'chrome.click', error: { message: 'x', kind: 'usage' } }));
  });
  const { added } = await loadPlugin(toolsPluginSource({ tools: [CHROME], codeMode: false }));
  const call = () => added[0].execute({ action: 'chrome.click' }, { sessionID: 'ses_1', signal: new AbortController().signal });

  withConnection(t, `${base}/broken`);
  const invalid = await call();
  assert.deepEqual(JSON.parse(invalid.content), { schemaVersion: 1, ok: false, action: 'chrome.click', error: { message: 'MittrCraft returned an invalid response', kind: 'runtime', status: 502 } });
  assert.deepEqual(invalid.metadata, { mittrcraft: { schemaVersion: 1, action: 'chrome.click', description: 'Click', ok: false } });

  process.env.MITTRCRAFT_TOOLS_URL = `${base}/refused`;
  const refused = await call();
  assert.equal(JSON.parse(refused.content).ok, false);
  assert.equal(refused.metadata.mittrcraft.ok, false);

  process.env.MITTRCRAFT_TOOLS_URL = 'http://127.0.0.1:9/mittr-tools/v1/call';
  const unreachable = JSON.parse((await call()).content);
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.error.kind, 'runtime');

  delete process.env.MITTRCRAFT_TOOLS_TOKEN;
  const missing = await call();
  assert.deepEqual(JSON.parse(missing.content), { schemaVersion: 1, ok: false, action: 'chrome.click', error: { message: 'The MittrCraft tools connection is unavailable', kind: 'runtime' } });
});

test('an aborted turn closes the callback request', async (t) => {
  let closed;
  const requestClosed = new Promise((resolve) => { closed = resolve; });
  const base = await listen(t, (req) => { req.on('close', closed); });
  withConnection(t, `${base}/mittr-tools/v1/call`);
  const { added } = await loadPlugin(toolsPluginSource({ tools: [CHROME], codeMode: false }));
  const controller = new AbortController();

  const pending = added[0].execute({ action: 'chrome.open' }, { sessionID: 'ses_1', signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();

  await requestClosed;
  const result = await pending;
  assert.equal(JSON.parse(result.content).ok, false);
});

test('the plugin is written privately under the data dir, and an unchanged one is left alone', { skip: process.platform === 'win32' }, async (t) => {
  const dataDir = tempDataDir(t);
  const source = toolsPluginSource({ tools: [CHROME], codeMode: false });
  const dir = await materializeToolsPlugin({ dataDir, source });

  assert.equal(dir, path.join(dataDir, 'engine-plugins', 'mittrcraft-tools'));
  assert.equal(toolsPluginDir(dataDir), dir);
  assert.equal(fs.readFileSync(path.join(dir, 'index.js'), 'utf8'), source);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')), { type: 'module', exports: { '.': './index.js' } });
  for (const name of ['index.js', 'package.json']) assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600, name);
  assert.deepEqual(toolsFragment(dir), { plugins: [dir] });

  const past = new Date('2026-01-01T00:00:00Z');
  for (const name of ['index.js', 'package.json']) fs.utimesSync(path.join(dir, name), past, past);
  await materializeToolsPlugin({ dataDir, source });
  for (const name of ['index.js', 'package.json']) assert.equal(fs.statSync(path.join(dir, name)).mtimeMs, past.getTime(), `${name} was written again`);

  const changed = toolsPluginSource({ tools: [COMPUTER], codeMode: false });
  await materializeToolsPlugin({ dataDir, source: changed });
  assert.equal(fs.readFileSync(path.join(dir, 'index.js'), 'utf8'), changed);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['index.js', 'package.json']);
});

test('the plugin names MittrCraft and none of the engine host\'s own names', () => {
  const source = toolsPluginSource({ tools: [CHROME, COMPUTER], codeMode: false });
  assert.doesNotMatch(source, /OpenChamber|OpenCode/);
});

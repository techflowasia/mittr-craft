import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { MARKER_PNG, PROVEN_IMAGE_PART } from '../../../../../scripts/mittr/probe-tool-plugin.mjs';
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

const loadPlugin = async (source, { web, permission } = {}) => {
  const plugin = (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default;
  const added = [];
  const looked = [];
  const tools = {
    add: (tool) => added.push(tool),
    get: (name) => {
      looked.push(name);
      return name === 'openchamber_web' ? web : undefined;
    },
    update: (name, fn) => {
      if (name !== 'openchamber_web' || !web) throw new Error(`no tool ${name}`);
      fn(web);
    },
  };
  const ctx = { tool: { transform: async (fn) => fn(tools) } };
  if (permission) ctx.permission = permission;
  await plugin.setup(ctx);
  return { plugin, added, looked };
};

const CAPTURE_PATH = '.openchamber/screenshots/home-2026-10-21T01-02-03-456.png';

const panelTool = (envelope) => {
  const content = JSON.stringify(envelope);
  const calls = [];
  return {
    calls,
    content,
    tool: {
      name: 'openchamber_web',
      execute: async (input, context) => {
        calls.push({ input, context });
        return { content, metadata: { panel: { action: envelope.action, ok: envelope.ok } } };
      },
    },
  };
};

const CAPTURED = { schemaVersion: 1, ok: true, action: 'browser.capture', data: { path: CAPTURE_PATH, hint: 'Write the path.' } };

const imageServer = async (t, answer) => {
  const seen = [];
  const base = await listen(t, async (req, res) => {
    const body = JSON.parse(await readBody(req));
    seen.push({ authorization: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(answer(body)));
  });
  return { base, seen };
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

test('a Mittr action\'s image reaches the model as an image part after the envelope text without the image', async (t) => {
  const envelope = { schemaVersion: 1, ok: true, action: 'chrome.open', data: { path: '.openchamber/screenshots/probe.png', url: 'http://a.test/', image: { base64: MARKER_PNG, mime: 'image/png' } } };
  const base = await listen(t, (req, res) => res.end(JSON.stringify(envelope)));
  withConnection(t, `${base}/mittr-tools/v1/call`);
  const { added } = await loadPlugin(toolsPluginSource({ tools: [CHROME], codeMode: false }));

  const result = await added[0].execute({ action: 'open' }, { sessionID: 'ses_1', signal: new AbortController().signal });

  assert.equal(result.content.length, 2);
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(result.content[0].text), { schemaVersion: 1, ok: true, action: 'chrome.open', data: { path: '.openchamber/screenshots/probe.png', url: 'http://a.test/' } });
  assert.deepEqual(result.content[1], PROVEN_IMAGE_PART);
  assert.deepEqual(result.metadata, { mittrcraft: { schemaVersion: 1, action: 'chrome.open', description: 'Open a page', ok: true } });
});

test('a Mittr image too large to attach becomes a sentence saying where it is saved', async (t) => {
  const envelope = { schemaVersion: 1, ok: true, action: 'chrome.open', data: { path: '.openchamber/screenshots/big.png', image: { tooLarge: true } } };
  const base = await listen(t, (req, res) => res.end(JSON.stringify(envelope)));
  withConnection(t, `${base}/mittr-tools/v1/call`);
  const { added } = await loadPlugin(toolsPluginSource({ tools: [CHROME], codeMode: false }));

  const result = await added[0].execute({ action: 'open' }, { sessionID: 'ses_1', signal: new AbortController().signal });

  assert.deepEqual(result.content, [
    { type: 'text', text: JSON.stringify({ schemaVersion: 1, ok: true, action: 'chrome.open', data: { path: '.openchamber/screenshots/big.png' } }) },
    { type: 'text', text: 'The image is too large to attach; it is saved at .openchamber/screenshots/big.png' },
  ]);
});

test('without wrapCapture the panel tool is left alone', async () => {
  const panel = panelTool(CAPTURED);
  const { looked } = await loadPlugin(toolsPluginSource({ tools: [CHROME], codeMode: false }), { web: panel.tool });
  assert.deepEqual(looked, []);
  assert.equal(toolsPluginSource({ tools: [CHROME], codeMode: false }).includes('openchamber_web'), false);
});

test('a capture of the panel tool gets the saved image after its own text', async (t) => {
  const { base, seen } = await imageServer(t, () => ({ schemaVersion: 1, ok: true, action: 'capture-image', data: { image: { base64: MARKER_PNG, mime: 'image/png' } } }));
  withConnection(t, `${base}/mittr-tools/v1/call`);
  const panel = panelTool(CAPTURED);
  const { added } = await loadPlugin(toolsPluginSource({ tools: [], codeMode: false, wrapCapture: true }), { web: panel.tool });
  const signal = new AbortController().signal;

  const result = await panel.tool.execute({ action: 'capture', parameters: { label: 'home' } }, { sessionID: 'ses_1', signal });

  assert.equal(added.length, 0);
  assert.equal(panel.calls.length, 1);
  assert.deepEqual(panel.calls[0].input, { action: 'capture', parameters: { label: 'home' } });
  assert.deepEqual(seen, [{ authorization: 'Bearer tok-1', body: { tool: 'openchamber_web', internal: 'capture-image', path: CAPTURE_PATH, sessionID: 'ses_1' } }]);
  assert.deepEqual(result.content, [
    { type: 'text', text: panel.content },
    { type: 'file', uri: `data:image/png;base64,${MARKER_PNG}`, mime: 'image/png', name: 'home-2026-10-21T01-02-03-456.png' },
  ]);
  assert.deepEqual(result.metadata, { panel: { action: 'browser.capture', ok: true } });
});

test('a panel capture too large to attach says where it is saved', async (t) => {
  const { base } = await imageServer(t, () => ({ schemaVersion: 1, ok: true, action: 'capture-image', data: { image: { tooLarge: true } } }));
  withConnection(t, `${base}/mittr-tools/v1/call`);
  const panel = panelTool(CAPTURED);
  await loadPlugin(toolsPluginSource({ tools: [CHROME], codeMode: false, wrapCapture: true }), { web: panel.tool });

  const result = await panel.tool.execute({ action: 'capture' }, { sessionID: 'ses_1', signal: new AbortController().signal });

  assert.deepEqual(result.content, [
    { type: 'text', text: panel.content },
    { type: 'text', text: `The image is too large to attach; it is saved at ${CAPTURE_PATH}` },
  ]);
});

test('a capture asked for another directory names it to the callback', async (t) => {
  const { base, seen } = await imageServer(t, () => ({ schemaVersion: 1, ok: false, action: 'capture-image', error: { message: 'That image is not a saved screenshot of this project', kind: 'usage' } }));
  withConnection(t, `${base}/mittr-tools/v1/call`);
  const panel = panelTool(CAPTURED);
  await loadPlugin(toolsPluginSource({ tools: [CHROME], codeMode: false, wrapCapture: true }), { web: panel.tool });

  const flat = await panel.tool.execute({ action: 'capture', directory: '/elsewhere' }, { sessionID: 'ses_1', signal: new AbortController().signal });
  const nested = await panel.tool.execute({ action: 'capture', directory: '/flat', parameters: { directory: '/nested' } }, { sessionID: 'ses_1', signal: new AbortController().signal });

  assert.deepEqual(seen.map(({ body }) => body.directory), ['/elsewhere', '/nested']);
  assert.equal(flat.content, panel.content);
  assert.equal(nested.content, panel.content);
});

test('a failed upstream capture passes through unchanged', async (t) => {
  const { base, seen } = await imageServer(t, () => ({ schemaVersion: 1, ok: true, action: 'capture-image', data: { image: { base64: MARKER_PNG, mime: 'image/png' } } }));
  withConnection(t, `${base}/mittr-tools/v1/call`);
  const context = { sessionID: 'ses_1', signal: new AbortController().signal };

  for (const envelope of [
    { schemaVersion: 1, ok: false, action: 'browser.capture', error: { message: 'The in-app browser is not available on this server', kind: 'runtime' } },
    { schemaVersion: 1, ok: true, action: 'browser.open', data: { path: CAPTURE_PATH } },
    { schemaVersion: 1, ok: true, action: 'browser.capture', data: {} },
  ]) {
    const panel = panelTool(envelope);
    await loadPlugin(toolsPluginSource({ tools: [CHROME], codeMode: false, wrapCapture: true }), { web: panel.tool });
    const result = await panel.tool.execute({ action: 'capture' }, context);
    assert.deepEqual(result, { content: panel.content, metadata: { panel: { action: envelope.action, ok: envelope.ok } } });
  }
  assert.deepEqual(seen, []);

  const panel = panelTool(CAPTURED);
  await loadPlugin(toolsPluginSource({ tools: [CHROME], codeMode: false, wrapCapture: true }), { web: panel.tool });
  process.env.MITTRCRAFT_TOOLS_URL = 'http://127.0.0.1:9/mittr-tools/v1/call';
  assert.equal((await panel.tool.execute({ action: 'capture' }, context)).content, panel.content);
  delete process.env.MITTRCRAFT_TOOLS_TOKEN;
  assert.equal((await panel.tool.execute({ action: 'capture' }, context)).content, panel.content);
});

test('with wrapCapture and no panel tool the plugin still loads its own tools', async () => {
  const { added, looked } = await loadPlugin(toolsPluginSource({ tools: [CHROME], codeMode: false, wrapCapture: true }));
  assert.deepEqual(looked, ['openchamber_web']);
  assert.deepEqual(added.map((tool) => tool.name), ['acme_chrome']);
});

test('the plugin with the capture wrap still has no import', () => {
  const source = toolsPluginSource({ tools: [CHROME], codeMode: false, wrapCapture: true });
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /OpenChamber|OpenCode/);
});

test('a capture callback that refuses the token, answers something not JSON, or sends a malformed image leaves the panel result unchanged', async (t) => {
  const answers = [
    (res) => { res.statusCode = 401; res.end(JSON.stringify({ error: 'Unauthorized' })); },
    (res) => { res.statusCode = 502; res.end('<html>bad gateway</html>'); },
    (res) => res.end(JSON.stringify({ schemaVersion: 1, ok: true, action: 'capture-image', data: { image: { base64: 5, mime: 'image/png' } } })),
    (res) => res.end(JSON.stringify({ schemaVersion: 1, ok: true, action: 'capture-image', data: { image: { base64: MARKER_PNG } } })),
    (res) => res.end(JSON.stringify({ schemaVersion: 1, ok: true, action: 'capture-image', data: { image: null } })),
    (res) => res.end(JSON.stringify({ schemaVersion: 1, ok: true, action: 'capture-image' })),
    (res) => res.end(JSON.stringify({ ok: true, data: { image: { base64: MARKER_PNG, mime: 'image/png' } } })),
  ];
  let served = 0;
  const base = await listen(t, (req, res) => {
    req.resume();
    answers[served++](res);
  });
  withConnection(t, `${base}/mittr-tools/v1/call`, 'wrong-token');
  const panel = panelTool(CAPTURED);
  await loadPlugin(toolsPluginSource({ tools: [CHROME], codeMode: false, wrapCapture: true }), { web: panel.tool });

  for (let index = 0; index < answers.length; index += 1) {
    const result = await panel.tool.execute({ action: 'capture' }, { sessionID: 'ses_1', signal: new AbortController().signal });
    assert.deepEqual(result, { content: panel.content, metadata: { panel: { action: 'browser.capture', ok: true } } }, `answer ${index}`);
  }
  assert.equal(served, answers.length);
});

test('a malformed Mittr image is dropped from the text and not attached', async (t) => {
  const envelope = { schemaVersion: 1, ok: true, action: 'chrome.open', data: { path: '.openchamber/screenshots/a.png', image: { base64: 5, mime: 'image/png' } } };
  const base = await listen(t, (req, res) => res.end(JSON.stringify(envelope)));
  withConnection(t, `${base}/mittr-tools/v1/call`);
  const { added } = await loadPlugin(toolsPluginSource({ tools: [CHROME], codeMode: false }));

  const result = await added[0].execute({ action: 'open' }, { sessionID: 'ses_1', signal: new AbortController().signal });

  assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify({ schemaVersion: 1, ok: true, action: 'chrome.open', data: { path: '.openchamber/screenshots/a.png' } }) }]);
});

test('a capture callback that does not answer in time leaves the panel result unchanged and closes the request', async (t) => {
  let closed;
  const requestClosed = new Promise((resolve) => { closed = resolve; });
  const base = await listen(t, (req) => { req.on('close', closed); });
  withConnection(t, `${base}/mittr-tools/v1/call`);
  const panel = panelTool(CAPTURED);
  await loadPlugin(toolsPluginSource({ tools: [CHROME], codeMode: false, wrapCapture: true, captureTimeoutMs: 50 }), { web: panel.tool });

  const started = Date.now();
  const result = await panel.tool.execute({ action: 'capture' }, { sessionID: 'ses_1', signal: new AbortController().signal });

  assert.equal(result.content, panel.content);
  assert.ok(Date.now() - started < 5000);
  await requestClosed;
});

test('the capture callback stops when the turn is aborted', async (t) => {
  let closed;
  const requestClosed = new Promise((resolve) => { closed = resolve; });
  const base = await listen(t, (req) => { req.on('close', closed); });
  withConnection(t, `${base}/mittr-tools/v1/call`);
  const panel = panelTool(CAPTURED);
  await loadPlugin(toolsPluginSource({ tools: [CHROME], codeMode: false, wrapCapture: true }), { web: panel.tool });
  const controller = new AbortController();

  const pending = panel.tool.execute({ action: 'capture' }, { sessionID: 'ses_1', signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();

  assert.equal((await pending).content, panel.content);
  await requestClosed;
});

test('a missing panel tool is logged once, and a present one is not logged', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { plugin } = await loadPlugin(toolsPluginSource({ tools: [CHROME], codeMode: false, wrapCapture: true, captureTimeoutMs: 1234 }));
  await plugin.setup({ tool: { transform: async (fn) => fn({ add: () => {}, get: () => undefined, update: () => {} }) } });

  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /panel browser tool was not found/);

  await loadPlugin(toolsPluginSource({ tools: [CHROME], codeMode: false, wrapCapture: true, captureTimeoutMs: 1235 }), { web: panelTool(CAPTURED).tool });
  assert.equal(warn.mock.callCount(), 1);
});

const hookRecorder = () => {
  const hooks = [];
  return { hooks, permission: { hook: async (name, fn) => { hooks.push({ name, fn }); } } };
};

test('the engine always asks about a permission the plugin names, even when a project rule allows it', async () => {
  const { hooks, permission } = hookRecorder();
  await loadPlugin(toolsPluginSource({ tools: [CHROME], codeMode: false, askPermissions: ['acme_chrome'] }), { permission });
  assert.deepEqual(hooks.map(({ name }) => name), ['evaluate']);
  const evaluate = (request) => {
    hooks[0].fn(request);
    return request.effect;
  };
  assert.equal(evaluate({ action: 'acme_chrome', resources: ['api.example.test'], metadata: { host: 'api.example.test' }, sessionID: 'ses_1', effect: 'allow' }), 'ask');
  assert.equal(evaluate({ action: 'acme_chrome', resources: ['api.example.test'], effect: 'deny' }), 'deny');
  assert.equal(evaluate({ action: 'acme_chrome', resources: ['api.example.test'], effect: 'ask' }), 'ask');
  assert.equal(evaluate({ action: 'acme_chrome', resources: ['*'], effect: 'allow' }), 'allow');
  assert.equal(evaluate({ action: 'acme_chrome', resources: [], effect: 'allow' }), 'allow');
  assert.equal(evaluate({ action: 'bash', resources: ['ls'], effect: 'allow' }), 'allow');
  assert.doesNotThrow(() => hooks[0].fn(undefined));
});

test('without a permission to ask about the plugin registers no permission hook', async () => {
  const { hooks, permission } = hookRecorder();
  const source = toolsPluginSource({ tools: [CHROME], codeMode: false });
  await loadPlugin(source, { permission });
  assert.deepEqual(hooks, []);
  assert.doesNotMatch(source, /evaluate/);
});

test('an engine without the permission hook still gets the tools, and the plugin says so', async (t) => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => { console.warn = original; });
  const { added } = await loadPlugin(toolsPluginSource({ tools: [CHROME], codeMode: false, askPermissions: ['acme_chrome'] }));
  assert.equal(added.length, 1);
  const failing = await loadPlugin(toolsPluginSource({ tools: [CHROME], codeMode: false, askPermissions: ['acme_chrome'] }), { permission: { hook: async () => { throw new Error('no hooks here'); } } });
  assert.equal(failing.added.length, 1);
  assert.equal(warnings.length, 2);
  for (const warning of warnings) assert.match(warning, /cannot be told to ask before a MittrCraft tool uses a site; MittrCraft still refuses every site the user has not allowed/);
});

test('a call names its message and tool call, so the site question sits on that call', async (t) => {
  const seen = [];
  const base = await listen(t, async (req, res) => {
    seen.push(JSON.parse(await readBody(req)));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ schemaVersion: 1, ok: true, action: 'chrome.open', data: {} }));
  });
  withConnection(t, `${base}/mittr-tools/v1/call`);
  const { added } = await loadPlugin(toolsPluginSource({ tools: [CHROME], codeMode: false }));
  await added[0].execute({ action: 'open' }, { sessionID: 'ses_1', messageID: 'msg_1', id: 'call_1', signal: new AbortController().signal });
  assert.deepEqual(seen, [{ tool: 'acme_chrome', input: { action: 'open' }, sessionID: 'ses_1', messageID: 'msg_1', callID: 'call_1' }]);
});

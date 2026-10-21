import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { MARKER_PNG } from '../../../../../scripts/mittr/probe-tool-plugin.mjs';
import { OPENCHAMBER_ALL_ACTIONS } from '../../../../web/server/lib/openchamber-control/actions.js';
import { SCREENSHOT_DIRECTORY } from '../../../../web/server/lib/openchamber-control/screenshots.js';
import { deferred, listen, until } from '../test-helpers.js';
import { TOOLS_CALLBACK_ROUTE, createToolsCallback } from './callback.js';
import { MittrToolError, createMittrActionRegistry } from './registry.js';

const recordingLogger = () => {
  const lines = [];
  const record = (...args) => lines.push(args.join(' '));
  return { lines, log: record, warn: record, error: record };
};

const setUp = async (t, { refusalFor = async () => null, resolveSessionDirectory = async (id) => `/work/${id}`, actions = {} } = {}) => {
  const registry = createMittrActionRegistry({ control: { all: OPENCHAMBER_ALL_ACTIONS, execute: async () => ({ upstream: true }) } });
  registry.defineTool({ name: 'acme_chrome', description: 'Chrome.', parameters: {} });
  registry.defineTool({ name: 'acme_other', description: 'Other.', parameters: {} });
  const calls = [];
  registry.register({
    action: 'chrome.open',
    tool: 'acme_chrome',
    title: 'Open a page',
    description: 'Opens a page.',
    effect: 'read',
    execute: actions.open ?? (async (input, ctx) => {
      calls.push({ input, ctx });
      return { opened: input.url };
    }),
  });
  registry.register({ action: 'chrome.fail', tool: 'acme_chrome', title: 'Fail', description: 'Fails.', effect: 'change', execute: actions.fail ?? (async () => { throw new MittrToolError('Not allowed on a.test', 403, { code: 'site_approval_required', host: 'a.test' }); }) });
  registry.register({ action: 'chrome.crash', tool: 'acme_chrome', title: 'Crash', description: 'Crashes.', effect: 'change', execute: async () => { throw new Error('driver went away'); } });
  registry.register({ action: 'other.ping', tool: 'acme_other', title: 'Ping', description: 'Pings.', effect: 'read', execute: async () => ({ pong: true }) });
  if (actions.shot) registry.register({ action: 'chrome.shot', tool: 'acme_chrome', title: 'Shot', description: 'Shoots.', effect: 'read', execute: actions.shot });

  const logger = recordingLogger();
  const callback = createToolsCallback({ crypto, registry, resolveSessionDirectory, refusalFor, screenshotFolder: SCREENSHOT_DIRECTORY, logger });
  const peer = { address: null };
  const app = express();
  app.use((req, res, next) => {
    if (peer.address) {
      Object.defineProperty(req.socket, 'remoteAddress', { value: peer.address, configurable: true });
      res.on('close', () => { delete req.socket.remoteAddress; });
    }
    next();
  });
  app.use(express.json({ limit: '50mb' }));
  callback.register(app);
  const base = await listen(t, app);
  const post = async (body, { token = callback.engineEnv(4100).MITTRCRAFT_TOOLS_TOKEN, headers = {}, signal } = {}) => {
    const sent = { 'content-type': 'application/json' };
    if (token) sent.authorization = `Bearer ${token}`;
    const response = await fetch(base + TOOLS_CALLBACK_ROUTE, {
      method: 'POST',
      headers: { ...sent, ...headers },
      body: JSON.stringify(body),
      signal,
    });
    return { status: response.status, body: await response.json() };
  };
  return { callback, post, peer, calls, logger, registry };
};

const OPEN = { tool: 'acme_chrome', input: { action: 'open', url: 'http://a.test/' }, sessionID: 'ses_1' };

test('the engine env names the loopback callback outside /api and a 32-byte token', async (t) => {
  const { callback } = await setUp(t);
  const env = callback.engineEnv(4100);
  assert.deepEqual(Object.keys(env).sort(), ['MITTRCRAFT_TOOLS_TOKEN', 'MITTRCRAFT_TOOLS_URL']);
  assert.equal(env.MITTRCRAFT_TOOLS_URL, 'http://127.0.0.1:4100/mittr-tools/v1/call');
  assert.equal(TOOLS_CALLBACK_ROUTE, '/mittr-tools/v1/call');
  assert.equal(Buffer.from(env.MITTRCRAFT_TOOLS_TOKEN, 'base64url').length, 32);
  assert.match(env.MITTRCRAFT_TOOLS_TOKEN, /^[A-Za-z0-9_-]{43}$/);
});

test('a call runs the calling tool\'s action with the session directory, the session and the agent surface', async (t) => {
  const { post, calls } = await setUp(t);
  const answer = await post({ ...OPEN, input: { action: 'open', url: 'http://flat.test/', parameters: { url: 'http://a.test/', ref: 'e1' } } });

  assert.deepEqual(answer, { status: 200, body: { schemaVersion: 1, ok: true, action: 'chrome.open', data: { opened: 'http://a.test/' } } });
  assert.deepEqual(calls[0].input, { action: 'chrome.open', url: 'http://a.test/', ref: 'e1' });
  const { signal, ...ctx } = calls[0].ctx;
  assert.ok(signal instanceof AbortSignal);
  assert.deepEqual(ctx, { directory: '/work/ses_1', sessionId: 'ses_1', surface: 'agent', tool: 'acme_chrome', via: 'engine' });
  assert.equal(Object.hasOwn(calls[0].ctx, 'scope'), false, 'an engine call claims no request scope');
});

test('a call carrying the previous start\'s token is refused', async (t) => {
  const { callback, post } = await setUp(t);
  const first = callback.engineEnv(4100).MITTRCRAFT_TOOLS_TOKEN;
  callback.engineReady();
  assert.equal((await post(OPEN, { token: first })).status, 200, 'the running engine\'s token works');

  const second = callback.engineEnv(4100).MITTRCRAFT_TOOLS_TOKEN;
  assert.notEqual(second, first);
  callback.engineReady();

  assert.deepEqual(await post(OPEN, { token: first }), { status: 401, body: { error: 'Unauthorized' } });
  assert.equal((await post(OPEN, { token: second })).status, 200);
});

test('a compatibility read between two starts changes nothing', async (t) => {
  const { callback, post } = await setUp(t);
  const started = callback.engineEnv(4100).MITTRCRAFT_TOOLS_TOKEN;
  callback.engineReady();
  const pending = callback.engineEnv(4100).MITTRCRAFT_TOOLS_TOKEN;
  assert.equal(callback.engineEnv(4100).MITTRCRAFT_TOOLS_TOKEN, pending, 'reading the env mints nothing');
  assert.equal((await post(OPEN, { token: started })).status, 200);
  assert.equal((await post(OPEN, { token: pending })).status, 200, 'the next start\'s token is ready before it starts');
});

test('a call without the token or with a wrong one is refused and runs nothing', async (t) => {
  const { post, calls } = await setUp(t);
  for (const token of [null, 'x', crypto.randomBytes(32).toString('base64url')]) {
    assert.deepEqual(await post(OPEN, { token }), { status: 401, body: { error: 'Unauthorized' } }, String(token));
  }
  assert.deepEqual(await post(OPEN, { token: null, headers: { authorization: 'Basic abc' } }), { status: 401, body: { error: 'Unauthorized' } });
  assert.equal(calls.length, 0);
});

test('a call from another machine or through a proxy header is refused', async (t) => {
  const { post, peer, calls } = await setUp(t);
  peer.address = '10.0.0.5';
  assert.deepEqual(await post(OPEN), { status: 401, body: { error: 'Unauthorized' } });
  peer.address = null;
  for (const header of ['x-forwarded-for', 'forwarded', 'via', 'x-openchamber-relay-connection']) {
    assert.deepEqual(await post(OPEN, { headers: { [header]: '203.0.113.9' } }), { status: 401, body: { error: 'Unauthorized' } }, header);
  }
  assert.equal(calls.length, 0);
});

test('an action of another tool, or an unknown one, answers a usage error listing the tool\'s own actions', async (t) => {
  const { post } = await setUp(t);
  for (const action of ['other.ping', 'session.create', 'nope']) {
    const { status, body } = await post({ ...OPEN, input: { action } });
    assert.equal(status, 200);
    assert.deepEqual(body, { schemaVersion: 1, ok: false, action, error: { message: `Unknown action "${action}" for acme_chrome; it has: chrome.open, chrome.fail, chrome.crash`, kind: 'usage' } });
  }
  assert.equal((await post({ ...OPEN, input: {} })).body.action, 'unknown');
});

test('a tool that is switched off is refused before anything runs', async (t) => {
  const { post, calls } = await setUp(t, { refusalFor: async (tool) => (tool === 'acme_chrome' ? new MittrToolError('The Chrome tool is turned off in Settings → Integrations', 403) : null) });
  assert.deepEqual((await post(OPEN)).body, { schemaVersion: 1, ok: false, action: 'open', error: { message: 'The Chrome tool is turned off in Settings → Integrations', kind: 'usage' } });
  assert.equal(calls.length, 0);
  assert.equal((await post({ tool: 'acme_other', input: { action: 'ping' }, sessionID: 's' })).body.ok, true);
});

test('a failure keeps its code and host and says usage for a 4xx and runtime otherwise', async (t) => {
  const { post } = await setUp(t);
  assert.deepEqual((await post({ ...OPEN, input: { action: 'fail' } })).body, {
    schemaVersion: 1,
    ok: false,
    action: 'chrome.fail',
    error: { message: 'Not allowed on a.test', kind: 'usage', code: 'site_approval_required', host: 'a.test' },
  });
  assert.deepEqual((await post({ ...OPEN, input: { action: 'crash' } })).body, { schemaVersion: 1, ok: false, action: 'chrome.crash', error: { message: 'driver went away', kind: 'runtime' } });
});

test('a session whose directory cannot be found runs with none', async (t) => {
  const { post, calls } = await setUp(t, { resolveSessionDirectory: async () => { throw new Error('no such session'); } });
  assert.equal((await post(OPEN)).body.ok, true);
  assert.equal(calls[0].ctx.directory, undefined);
  assert.equal((await post({ tool: 'acme_chrome', input: { action: 'open' } })).body.ok, true);
  assert.equal(calls[1].ctx.sessionId, undefined);
});

test('the token and the request body never reach the log', async (t) => {
  const { post, callback, logger } = await setUp(t);
  const token = callback.engineEnv(4100).MITTRCRAFT_TOOLS_TOKEN;
  await post({ ...OPEN, input: { action: 'fail', value: 'secret-typed-text' } });
  await post({ ...OPEN, input: { action: 'crash', value: 'secret-typed-text' } });
  await post({ ...OPEN, input: { action: 'agent wrote this', value: 'secret-typed-text' } });
  await post(OPEN, { token: 'wrong-token-value' });
  assert.deepEqual(logger.lines, [
    '[mittr] tool chrome.fail failed: 403',
    '[mittr] tool chrome.crash failed: 500',
    '[mittr] tool unknown failed: 400',
  ]);
  for (const line of logger.lines) {
    for (const secret of [token, 'secret-typed-text', 'agent wrote this', 'wrong-token-value', 'a.test']) assert.equal(line.includes(secret), false, line);
  }
});

const hangingOpen = () => {
  const started = deferred();
  const aborted = deferred();
  return {
    started: started.promise,
    aborted: aborted.promise,
    open: (_input, ctx) => new Promise((_resolve, reject) => {
      ctx.signal.addEventListener('abort', () => {
        aborted.resolve(true);
        reject(new Error('aborted'));
      }, { once: true });
      started.resolve();
    }),
  };
};

test('an aborted turn aborts its in-flight action', async (t) => {
  const hang = hangingOpen();
  const { post, callback } = await setUp(t, { actions: { open: hang.open } });
  const controller = new AbortController();
  const call = post(OPEN, { signal: controller.signal }).catch(() => null);
  await hang.started;

  assert.equal(callback.abortSession('ses_other'), 0);
  assert.equal(callback.abortSession('ses_1'), 1);
  assert.equal(await hang.aborted, true);
  assert.deepEqual((await call)?.body?.ok, false);
  controller.abort();
});

test('the engine closing the call aborts the action', async (t) => {
  const hang = hangingOpen();
  const { post, callback } = await setUp(t, { actions: { open: hang.open } });
  const controller = new AbortController();
  const call = post(OPEN, { signal: controller.signal }).catch((error) => error.name);
  await hang.started;

  controller.abort();

  assert.equal(await hang.aborted, true);
  assert.equal(await call, 'AbortError');
  await until(() => callback.abortSession('ses_1') === 0);
});

const tempProject = (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-capture-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, SCREENSHOT_DIRECTORY), { recursive: true });
  return { root, project };
};

const CAPTURE = '.openchamber/screenshots/home-2026-10-21T01-02-03-456.png';
const captureCall = (extra = {}) => ({ tool: 'openchamber_web', internal: 'capture-image', path: CAPTURE, sessionID: 'ses_1', ...extra });
const NOT_A_SCREENSHOT = { message: 'That image is not a saved screenshot of this project', kind: 'usage' };

test('a panel capture saved in the session\'s screenshots folder answers its image', async (t) => {
  const { project } = tempProject(t);
  fs.writeFileSync(path.join(project, CAPTURE), Buffer.from(MARKER_PNG, 'base64'));
  const { post, calls } = await setUp(t, { resolveSessionDirectory: async (id) => (id === 'ses_1' ? project : null) });

  assert.deepEqual((await post(captureCall())).body, { schemaVersion: 1, ok: true, action: 'capture-image', data: { image: { base64: MARKER_PNG, mime: 'image/png' } } });
  assert.equal((await post(captureCall({ directory: project }))).body.ok, true);
  assert.equal((await post(captureCall({ directory: `${project}/./` }))).body.ok, true);
  assert.equal(calls.length, 0);
});

test('an upstream capture saved under another directory passes through without an image', async (t) => {
  const { root, project } = tempProject(t);
  const other = path.join(root, 'other');
  fs.mkdirSync(path.join(other, SCREENSHOT_DIRECTORY), { recursive: true });
  fs.writeFileSync(path.join(other, CAPTURE), Buffer.from(MARKER_PNG, 'base64'));
  fs.writeFileSync(path.join(project, CAPTURE), Buffer.from(MARKER_PNG, 'base64'));
  const { post, logger } = await setUp(t, { resolveSessionDirectory: async () => project });

  assert.deepEqual((await post(captureCall({ directory: other }))).body, { schemaVersion: 1, ok: false, action: 'capture-image', error: NOT_A_SCREENSHOT });
  assert.deepEqual((await post(captureCall({ directory: 'relative/dir' }))).body.error, NOT_A_SCREENSHOT);
  assert.deepEqual(logger.lines, ['[mittr] tool capture-image failed: 400', '[mittr] tool capture-image failed: 400']);
  for (const line of logger.lines) assert.equal(line.includes(project) || line.includes('home-'), false, line);
});

test('a panel capture with no session directory, outside the folder, or from another tool is refused', async (t) => {
  const { project } = tempProject(t);
  fs.writeFileSync(path.join(project, 'x.png'), Buffer.from(MARKER_PNG, 'base64'));
  const noSession = await setUp(t, { resolveSessionDirectory: async () => null });
  assert.deepEqual((await noSession.post(captureCall())).body.error, NOT_A_SCREENSHOT);

  const { post } = await setUp(t, { resolveSessionDirectory: async () => project });
  assert.deepEqual((await post(captureCall({ path: '../x.png' }))).body.error, NOT_A_SCREENSHOT);
  assert.deepEqual((await post(captureCall({ path: 'x.png' }))).body.error, NOT_A_SCREENSHOT);
  assert.deepEqual((await post(captureCall({ tool: 'acme_chrome' }))).body, { schemaVersion: 1, ok: false, action: 'capture-image', error: { message: 'Only the panel browser tool asks for a capture image', kind: 'usage' } });
});

test('a panel capture over 5 MiB answers that it is too large', async (t) => {
  const { project } = tempProject(t);
  const png = Buffer.from(MARKER_PNG, 'base64');
  fs.writeFileSync(path.join(project, CAPTURE), Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024 + 1 - png.length)]));
  const { post } = await setUp(t, { resolveSessionDirectory: async () => project });
  assert.deepEqual((await post(captureCall())).body, { schemaVersion: 1, ok: true, action: 'capture-image', data: { image: { tooLarge: true } } });
});

test('a panel capture is refused while the panel tool is switched off', async (t) => {
  const { project } = tempProject(t);
  fs.writeFileSync(path.join(project, CAPTURE), Buffer.from(MARKER_PNG, 'base64'));
  const { post } = await setUp(t, {
    resolveSessionDirectory: async () => project,
    refusalFor: async (tool) => (tool === 'openchamber_web' ? new MittrToolError('off', 403) : null),
  });
  assert.deepEqual((await post(captureCall())).body, { schemaVersion: 1, ok: false, action: 'capture-image', error: { message: 'off', kind: 'usage' } });
});

test('a Mittr action\'s image over 5 MiB is answered as too large and its path is kept', async (t) => {
  const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
  const { post } = await setUp(t, { actions: { shot: async () => ({ path: '.openchamber/screenshots/a.png', image: { base64: big, mime: 'image/png' } }) } });
  assert.deepEqual((await post({ ...OPEN, input: { action: 'shot' } })).body, { schemaVersion: 1, ok: true, action: 'chrome.shot', data: { path: '.openchamber/screenshots/a.png', image: { tooLarge: true } } });

  const small = await setUp(t, { actions: { shot: async () => ({ path: '.openchamber/screenshots/b.png', image: { base64: MARKER_PNG, mime: 'image/png' } }) } });
  assert.deepEqual((await small.post({ ...OPEN, input: { action: 'shot' } })).body.data, { path: '.openchamber/screenshots/b.png', image: { base64: MARKER_PNG, mime: 'image/png' } });
});

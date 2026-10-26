import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { OPENCHAMBER_ALL_ACTIONS } from '../../../../web/server/lib/openchamber-control/actions.js';
import { serve } from '../test-helpers.js';
import { registerMittrControlRoutes } from '../tools/control-routes.js';
import { MITTR_TOOLS, MittrToolError, UPSTREAM_SWITCHES, createMittrActionRegistry } from '../tools/registry.js';
import { NOTHING_TO_ALLOW, registerVoiceActions } from './actions.js';
import { createVoiceConversation } from './conversation.js';

const ENGINE = { url: (route) => `http://127.0.0.1:4096${route}`, authHeaders: () => ({ authorization: 'Basic acme' }) };

const setUp = ({ messages = [{ role: 'assistant', text: '## Done\nFixed **it** in `a.js`' }], replyMaxChars = 8000, chromeOn = true } = {}) => {
  const controlCalls = [];
  const control = {
    all: OPENCHAMBER_ALL_ACTIONS,
    definitions: () => ({ control: [], web: [] }),
    resolveSessionDirectory: async (id) => `/work/${id}`,
    execute: async (...args) => {
      controlCalls.push(args);
      return { sessionId: args[1].sessionId, messages };
    },
  };
  const registry = createMittrActionRegistry({ control });
  const engineCalls = [];
  const fetchImpl = async (url, init) => {
    engineCalls.push({ url: String(url), method: init.method, directory: init.headers['x-opencode-directory'] });
    return new Response(JSON.stringify({ interrupted: true }), { status: 200 });
  };
  const grants = [];
  const chrome = { allowForConversation: (id) => grants.push(id) };
  const conversation = createVoiceConversation();
  const switchesAsked = [];
  registry.useSwitches(async (name) => {
    switchesAsked.push(name);
    return null;
  });
  registerVoiceActions(registry, { control, engine: ENGINE, chrome, conversation, settings: { read: async () => ({ voice: { stepCap: 8, replyMaxChars } }) }, chromeAvailable: () => chromeOn, fetchImpl });
  const voice = (ctx = {}) => ({ surface: 'voice', scope: { local: true }, sessionId: 'voice', ...ctx });
  return { registry, control, controlCalls, engineCalls, grants, conversation, switchesAsked, voice };
};

test('session.stop interrupts the session in its own directory', async () => {
  const { registry, engineCalls, voice } = setUp();
  assert.deepEqual(await registry.execute('session.stop', { sessionId: 'ses_1' }, voice()), { stopped: true, sessionId: 'ses_1', directory: '/work/ses_1' });
  assert.deepEqual(engineCalls, [{ url: 'http://127.0.0.1:4096/api/session/ses_1/interrupt', method: 'POST', directory: encodeURIComponent('/work/ses_1') }]);
  await registry.execute('session.stop', { sessionId: 'ses_2', directory: '/elsewhere' }, voice());
  assert.equal(engineCalls[1].directory, encodeURIComponent('/elsewhere'));
  await assert.rejects(registry.execute('session.stop', {}, voice()), (error) => error.statusCode === 400);
});

test('read_reply never cuts an emoji in half at the setting', async () => {
  const { registry, voice } = setUp({ messages: [{ role: 'assistant', text: `${'a'.repeat(999)}\u{1F600}b` }], replyMaxChars: 1000 });
  const reply = await registry.execute('session.read_reply', { sessionId: 'ses_1' }, voice());
  assert.equal(reply.text, 'a'.repeat(999));
  assert.equal(reply.truncated, true);
  assert.equal(/[\ud800-\udbff]$/.test(reply.text), false);
});

test('read_reply speaks the latest answer without Markdown, cut at the setting', async () => {
  const long = setUp({ messages: [{ text: `**${'word '.repeat(400)}**` }], replyMaxChars: 1000 });
  const reply = await long.registry.execute('session.read_reply', { sessionId: 'ses_1' }, long.voice());
  assert.equal(reply.text.length, 1000);
  assert.equal(reply.truncated, true);
  assert.equal(reply.text.includes('*'), false);
  assert.deepEqual(long.controlCalls[0].slice(0, 3), ['session.messages', { sessionId: 'ses_1', directory: '/work/ses_1', role: 'assistant', last: true }, '/work/ses_1']);

  const short = setUp();
  assert.deepEqual(await short.registry.execute('session.read_reply', { sessionId: 'ses_1' }, short.voice()), { sessionId: 'ses_1', directory: '/work/ses_1', text: 'Done Fixed it in', truncated: false });
  const none = setUp({ messages: [] });
  assert.equal((await none.registry.execute('session.read_reply', { sessionId: 'ses_1' }, none.voice())).text, null);
});

test('chrome.allow_site uses the pending host of this conversation, not the model\'s spelling', async () => {
  const { registry, grants, conversation, voice } = setUp();
  const id = conversation.start();
  await assert.rejects(registry.execute('chrome.allow_site', { host: 'evil.test' }, voice({ conversationId: id })), (error) => error instanceof MittrToolError && error.statusCode === 409 && error.message === NOTHING_TO_ALLOW);
  conversation.setPendingHost('shop.test');
  await assert.rejects(registry.execute('chrome.allow_site', {}, voice({ conversationId: 'old' })), (error) => error.statusCode === 409);
  assert.deepEqual(await registry.execute('chrome.allow_site', { host: 'evil.test' }, voice({ conversationId: id })), { allowed: true, scope: 'conversation', sites: 'all' });
  assert.deepEqual(grants, ['voice']);
  assert.equal(conversation.chromeAllowed(), true);
});

test('the voice actions answer the control and Chrome switches, and Chrome\'s availability', async () => {
  const { registry, switchesAsked, conversation, voice } = setUp({ chromeOn: false });
  await registry.execute('session.stop', { sessionId: 'ses_1' }, voice());
  await registry.execute('session.read_reply', { sessionId: 'ses_1' }, voice());
  assert.deepEqual(switchesAsked, [UPSTREAM_SWITCHES.control, UPSTREAM_SWITCHES.control]);
  const id = conversation.start();
  await assert.rejects(registry.execute('chrome.allow_site', {}, voice({ conversationId: id })), (error) => error.statusCode === 503);
  assert.equal(registry.definitions({ includeVoiceOnly: true }).find(({ action }) => action === 'chrome.allow_site').available, false);
  assert.equal(MITTR_TOOLS.chrome, 'mittrcraft_chrome');
});

test('the http surface cannot run chrome.allow_site', async (t) => {
  const { registry, conversation, grants } = setUp();
  conversation.start();
  conversation.setPendingHost('shop.test');
  const app = express();
  registerMittrControlRoutes(app, { express, registry, host: {}, requestScope: () => 'local', ControlError: Error });
  const call = await serve(t, app);
  assert.deepEqual(await call('POST', '/api/mittr/control', { action: 'chrome.allow_site', input: { host: 'shop.test' } }), { status: 400, body: { error: 'Allow Chrome for this conversation can only be asked for by voice' } });
  assert.deepEqual(grants, []);
});

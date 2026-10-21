import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { deferred, serve } from '../test-helpers.js';
import { registerMittrControlRoutes } from './control-routes.js';
import { MittrToolError, createMittrActionRegistry } from './registry.js';

const ROUTE = '/api/mittr/control';

const setUp = async (t, { answer = async () => ({ sessions: [] }), register = () => {} } = {}) => {
  const calls = [];
  const control = {
    execute: async (...args) => {
      calls.push(args);
      return answer(...args);
    },
    resolveSessionDirectory: async () => null,
    definitions: () => ({ control: [{ action: 'session.list', title: 'List sessions', description: 'List' }], web: [] }),
  };
  const registry = createMittrActionRegistry({ control });
  registry.defineTool({ name: 'mittrcraft_chrome', description: 'Drive Chrome', parameters: { type: 'object' } });
  register(registry);
  const app = express();
  registerMittrControlRoutes(app, { express, registry });
  return { calls, call: await serve(t, app) };
};

test('an upstream action answers its data, with the directory and session the request names', async (t) => {
  const { calls, call } = await setUp(t);

  assert.deepEqual(await call('POST', ROUTE, { action: 'session.list', input: { limit: 2 }, contextDirectory: '/p', contextSessionId: 's1' }), { status: 200, body: { sessions: [] } });

  assert.equal(calls.length, 1);
  const [action, input, directory, options] = calls[0];
  assert.deepEqual([action, input, directory], ['session.list', { limit: 2 }, '/p']);
  assert.equal(options.contextSessionId, 's1');
  assert.ok(options.signal instanceof AbortSignal);
});

test('a Mittr action runs on the http surface with an object input', async (t) => {
  const seen = [];
  const { call } = await setUp(t, {
    register: (registry) => registry.register({
      action: 'chrome.read', tool: 'mittrcraft_chrome', title: 'Read the Chrome page', description: 'Read', effect: 'read',
      execute: async (input, ctx) => {
        seen.push({ input, directory: ctx.directory, sessionId: ctx.sessionId, surface: ctx.surface });
        return { text: 'page' };
      },
    }),
  });

  assert.deepEqual(await call('POST', ROUTE, { action: 'chrome.read', input: ['not', 'an', 'object'] }), { status: 200, body: { text: 'page' } });
  assert.deepEqual(seen, [{ input: {}, directory: undefined, sessionId: undefined, surface: 'http' }]);
});

test('the http route answers the error status and code', async (t) => {
  const { call } = await setUp(t, {
    register: (registry) => registry.register({
      action: 'chrome.open', tool: 'mittrcraft_chrome', title: 'Open a page in Chrome', description: 'Open', effect: 'change',
      execute: async () => { throw new MittrToolError('x', 403, { code: 'site_approval_required', host: 'a.test' }); },
    }),
  });

  assert.deepEqual(await call('POST', ROUTE, { action: 'chrome.open', input: {} }), {
    status: 403,
    body: { error: 'x', code: 'site_approval_required', host: 'a.test' },
  });
});

test('an upstream failure keeps its status and partial result, and a plain error is a 500', async (t) => {
  let failure = null;
  const { call } = await setUp(t, { answer: async () => { throw failure; } });

  failure = Object.assign(new Error('dispatch failed'), {
    statusCode: 502, partial: true, partialAction: 'fork-created', sessionId: 'ses_fork', directory: '/repo', goalConfigured: true,
  });
  assert.deepEqual(await call('POST', ROUTE, { action: 'session.list' }), {
    status: 502,
    body: { error: 'dispatch failed', partial: true, partialAction: 'fork-created', sessionId: 'ses_fork', directory: '/repo' },
  });

  failure = Object.assign(new Error('busy'), { status: 409, code: 'ECONNRESET' });
  assert.deepEqual(await call('POST', ROUTE, { action: 'session.list' }), { status: 409, body: { error: 'busy' } });

  failure = new Error('');
  assert.deepEqual(await call('POST', ROUTE, { action: 'session.list' }), { status: 500, body: { error: 'Action failed' } });
});

test('a refused action answers its status', async (t) => {
  const { call, calls } = await setUp(t, {
    register: (registry) => registry.register({
      action: 'chrome.open', tool: 'mittrcraft_chrome', title: 'Open a page in Chrome', description: 'Open', effect: 'change',
      available: () => false,
      execute: async () => ({}),
    }),
  });

  assert.deepEqual(await call('POST', ROUTE, { action: 'chrome.open' }), { status: 503, body: { error: 'Open a page in Chrome is not available in this install' } });
  assert.equal(calls.length, 0);
});

test('a body that is not JSON answers 400', async (t) => {
  const { call, calls } = await setUp(t);

  const response = await fetch(call.base + ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Invalid request body' });
  assert.equal(calls.length, 0);
});

test('the request\'s close aborts the action', async (t) => {
  const started = deferred();
  const aborted = deferred();
  const { call } = await setUp(t, {
    register: (registry) => registry.register({
      action: 'chrome.read', tool: 'mittrcraft_chrome', title: 'Read the Chrome page', description: 'Read', effect: 'read',
      execute: (_input, ctx) => new Promise((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => {
          aborted.resolve(true);
          reject(new MittrToolError('cancelled', 499));
        });
        started.resolve();
      }),
    }),
  });

  const client = new AbortController();
  const request = fetch(call.base + ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'chrome.read' }),
    signal: client.signal,
  }).catch((error) => error);
  await started.promise;
  client.abort();

  assert.equal(await aborted.promise, true);
  assert.equal((await request).name, 'AbortError');
});

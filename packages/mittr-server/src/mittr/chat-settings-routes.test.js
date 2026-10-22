import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { serve } from './test-helpers.js';
import { registerChatSettingsRoutes } from './chat-settings-routes.js';

const ROUTE = '/api/mittr/chat/settings';

const quietLogger = () => {
  const lines = [];
  const record = (...args) => lines.push(args.join(' '));
  return { lines, log: record, warn: record, error: record };
};

const fakeSettings = ({ suggestionStyle = 'next-step', failWith = null } = {}) => {
  let current = suggestionStyle;
  const updates = [];
  return {
    updates,
    read: async () => ({ suggestionStyle: current }),
    update: async (patch) => {
      updates.push(patch);
      if (failWith) throw failWith;
      current = patch.suggestionStyle;
      return { suggestionStyle: current };
    },
  };
};

const fakeStyle = () => {
  const applied = [];
  return { applied, apply: (style) => { applied.push(style); return true; } };
};

const setUp = async (t, { scope = 'local', host = {}, peer = null, settings = fakeSettings(), style = fakeStyle() } = {}) => {
  const app = express();
  if (peer) {
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'socket', { value: { remoteAddress: peer } });
      next();
    });
  }
  const logger = quietLogger();
  registerChatSettingsRoutes(app, { express, host, requestScope: () => scope, mittrSettings: settings, suggestionStyle: style, logger });
  return { call: await serve(t, app), settings, style, logger };
};

test('GET answers the stored suggestion style and whether this request may change it', async (t) => {
  const { call } = await setUp(t);
  assert.deepEqual(await call('GET', ROUTE), { status: 200, body: { suggestionStyle: 'next-step', canChange: true } });

  const stored = await setUp(t, { settings: fakeSettings({ suggestionStyle: 'unfinished-only' }) });
  assert.deepEqual((await stored.call('GET', ROUTE)).body, { suggestionStyle: 'unfinished-only', canChange: true });

  for (const [options, label] of [
    [{ scope: 'tunnel' }, 'a tunnel request'],
    [{ scope: 'remote' }, 'a remote request'],
    [{ peer: '192.0.2.7' }, 'a peer that is not loopback'],
    [{ host: null }, 'no desktop host'],
  ]) {
    const { call: other } = await setUp(t, options);
    assert.deepEqual((await other('GET', ROUTE)).body, { suggestionStyle: 'next-step', canChange: false }, label);
  }
});

test('PUT stores the style and applies it to the suggestions', async (t) => {
  const { call, settings, style } = await setUp(t);
  assert.deepEqual(await call('PUT', ROUTE, { suggestionStyle: 'unfinished-only' }), { status: 200, body: { suggestionStyle: 'unfinished-only', canChange: true } });
  assert.deepEqual(await call('PUT', ROUTE, { suggestionStyle: 'next-step' }), { status: 200, body: { suggestionStyle: 'next-step', canChange: true } });
  assert.deepEqual(settings.updates, [{ suggestionStyle: 'unfinished-only' }, { suggestionStyle: 'next-step' }]);
  assert.deepEqual(style.applied, ['unfinished-only', 'next-step']);
});

test('any other body answers 400 and stores nothing', async (t) => {
  const { call, settings, style } = await setUp(t);
  const invalid = 'suggestionStyle must be next-step or unfinished-only';
  for (const [body, error] of [
    [{ suggestionStyle: 'always' }, invalid],
    [{ suggestionStyle: '' }, invalid],
    [{ suggestionStyle: null }, invalid],
    [{ suggestionStyle: true }, invalid],
    [{ suggestionStyle: 'next-step', other: 1 }, invalid],
    [{ canChange: true }, invalid],
    [{}, invalid],
    [['next-step'], invalid],
  ]) {
    assert.deepEqual(await call('PUT', ROUTE, body), { status: 400, body: { error } }, JSON.stringify(body));
  }
  assert.deepEqual(settings.updates, []);
  assert.deepEqual(style.applied, []);
  const oversized = await fetch(`${call.base}${ROUTE}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ suggestionStyle: 'next-step', pad: 'x'.repeat(9 * 1024) }),
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(settings.updates, []);
});

test('a forwarded request cannot change it', async (t) => {
  const refused = { status: 403, body: { error: 'These settings can be changed only on this Mac' } };
  const cases = [
    [{ scope: 'tunnel' }, {}],
    [{ scope: 'remote' }, {}],
    [{ peer: '192.0.2.7' }, {}],
    [{ host: null }, {}],
    [{}, { 'x-forwarded-for': '198.51.100.4' }],
    [{}, { forwarded: 'for=198.51.100.4' }],
  ];
  for (const [options, headers] of cases) {
    const { call, settings, style } = await setUp(t, options);
    const response = await fetch(`${call.base}${ROUTE}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ suggestionStyle: 'unfinished-only' }),
    });
    assert.deepEqual({ status: response.status, body: await response.json() }, refused, JSON.stringify({ options, headers }));
    assert.deepEqual(settings.updates, [], JSON.stringify({ options, headers }));
    assert.deepEqual(style.applied, [], JSON.stringify({ options, headers }));
  }
});

test('a style that cannot be stored answers 500 without saying why and applies nothing', async (t) => {
  const { call, logger, style } = await setUp(t, { settings: fakeSettings({ failWith: new Error('EACCES: /secret/dir') }) });
  assert.deepEqual(await call('PUT', ROUTE, { suggestionStyle: 'unfinished-only' }), { status: 500, body: { error: 'Cannot store the suggestion setting on this machine' } });
  assert.deepEqual(style.applied, []);
  assert.ok(logger.lines.some((line) => line.includes('could not be stored')));
});

test('a stored style the server cannot take answers 500 and says it is saved', async (t) => {
  const style = { applied: [], apply: (value) => { style.applied.push(value); return false; } };
  const { call } = await setUp(t, { style });
  assert.deepEqual(await call('PUT', ROUTE, { suggestionStyle: 'next-step' }), {
    status: 500,
    body: { error: 'The suggestion setting is saved, but it could not be applied yet', suggestionStyle: 'next-step', canChange: true },
  });
});

test('a style that cannot be read answers a JSON error, never the default page', async (t) => {
  const { call } = await setUp(t, { settings: { read: async () => { throw new Error('damaged'); }, update: async () => ({}) } });
  assert.deepEqual(await call('GET', ROUTE), { status: 500, body: { error: 'Could not read the suggestion setting' } });
});

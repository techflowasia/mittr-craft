import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { serve } from '../test-helpers.js';
import { registerVoiceSettingsRoutes } from './settings-routes.js';

const quietLogger = () => {
  const lines = [];
  const record = (...args) => lines.push(args.join(' '));
  return { lines, log: record, warn: record, error: record };
};

const fakeSettings = ({ stored = {}, failWith = null } = {}) => {
  let voice = { stepCap: 8, replyMaxChars: 8000, ...stored };
  const updates = [];
  return {
    updates,
    read: async () => ({ voice }),
    update: async (patch) => {
      updates.push(patch);
      if (failWith) throw failWith;
      voice = { ...voice, ...patch.voice };
      return { voice };
    },
  };
};

const setUp = async (t, { scope = 'local', host = {}, peer = null, settings = fakeSettings() } = {}) => {
  const app = express();
  if (peer) {
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'socket', { value: { remoteAddress: peer } });
      next();
    });
  }
  const logger = quietLogger();
  registerVoiceSettingsRoutes(app, { express, host, requestScope: () => scope, mittrSettings: settings, logger });
  return { call: await serve(t, app), settings, logger };
};

test('GET answers the stored limits and whether this request may change them', async (t) => {
  const { call } = await setUp(t);
  assert.deepEqual(await call('GET', '/api/mittr/voice/settings'), { status: 200, body: { stepCap: 8, replyMaxChars: 8000, canChange: true } });

  const stored = await setUp(t, { settings: fakeSettings({ stored: { stepCap: 3, replyMaxChars: 1500 } }) });
  assert.deepEqual((await stored.call('GET', '/api/mittr/voice/settings')).body, { stepCap: 3, replyMaxChars: 1500, canChange: true });

  for (const [options, label] of [
    [{ scope: 'tunnel' }, 'a tunnel request'],
    [{ scope: 'remote' }, 'a remote request'],
    [{ peer: '192.0.2.7' }, 'a peer that is not loopback'],
    [{ host: null }, 'no desktop host'],
  ]) {
    const { call: other } = await setUp(t, options);
    assert.deepEqual((await other('GET', '/api/mittr/voice/settings')).body, { stepCap: 8, replyMaxChars: 8000, canChange: false }, label);
  }
});

test('PUT stores in-range limits', async (t) => {
  const { call, settings } = await setUp(t);

  assert.deepEqual(await call('PUT', '/api/mittr/voice/settings', { stepCap: 12 }), { status: 200, body: { stepCap: 12, replyMaxChars: 8000, canChange: true } });
  assert.deepEqual(await call('PUT', '/api/mittr/voice/settings', { replyMaxChars: 30000, stepCap: 1 }), { status: 200, body: { stepCap: 1, replyMaxChars: 30000, canChange: true } });
  assert.deepEqual(await call('PUT', '/api/mittr/voice/settings', { stepCap: 20, replyMaxChars: 1000 }), { status: 200, body: { stepCap: 20, replyMaxChars: 1000, canChange: true } });
  assert.deepEqual(settings.updates, [
    { voice: { stepCap: 12 } },
    { voice: { replyMaxChars: 30000, stepCap: 1 } },
    { voice: { stepCap: 20, replyMaxChars: 1000 } },
  ]);
});

test('an out-of-range value answers 400 and stores nothing', async (t) => {
  const { call, settings } = await setUp(t);
  for (const [body, error] of [
    [{ stepCap: 0 }, 'Unknown or invalid voice setting: stepCap'],
    [{ stepCap: 21 }, 'Unknown or invalid voice setting: stepCap'],
    [{ stepCap: 2.5 }, 'Unknown or invalid voice setting: stepCap'],
    [{ stepCap: '8' }, 'Unknown or invalid voice setting: stepCap'],
    [{ stepCap: null }, 'Unknown or invalid voice setting: stepCap'],
    [{ replyMaxChars: 999 }, 'Unknown or invalid voice setting: replyMaxChars'],
    [{ replyMaxChars: 30001 }, 'Unknown or invalid voice setting: replyMaxChars'],
    [{ replyMaxChars: 1e9 }, 'Unknown or invalid voice setting: replyMaxChars'],
    [{ replyMaxChars: true }, 'Unknown or invalid voice setting: replyMaxChars'],
    [{ stepCap: 5, replyMaxChars: 5 }, 'Unknown or invalid voice setting: replyMaxChars'],
    [{ stepCap: 5, silenceMs: 10 }, 'Unknown or invalid voice setting: silenceMs'],
    [{ canChange: true }, 'Unknown or invalid voice setting: canChange'],
    [{}, 'Give at least one voice setting'],
    [[8], 'Give at least one voice setting'],
  ]) {
    assert.deepEqual(await call('PUT', '/api/mittr/voice/settings', body), { status: 400, body: { error } }, JSON.stringify(body));
  }
  assert.deepEqual(settings.updates, []);
  const oversized = await fetch(`${call.base}/api/mittr/voice/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stepCap: 5, pad: 'x'.repeat(9 * 1024) }),
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(settings.updates, []);
});

test('a forwarded request cannot change them', async (t) => {
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
    const { call, settings } = await setUp(t, options);
    const response = await fetch(`${call.base}/api/mittr/voice/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ stepCap: 3 }),
    });
    assert.deepEqual({ status: response.status, body: await response.json() }, refused, JSON.stringify({ options, headers }));
    assert.deepEqual(settings.updates, [], JSON.stringify({ options, headers }));
  }
});

test('a limit that cannot be stored answers 500 without saying why', async (t) => {
  const { call, logger } = await setUp(t, { settings: fakeSettings({ failWith: new Error('EACCES: /secret/dir') }) });
  const answer = await call('PUT', '/api/mittr/voice/settings', { stepCap: 3 });
  assert.deepEqual(answer, { status: 500, body: { error: 'Cannot store the voice setting on this machine' } });
  assert.ok(logger.lines.some((line) => line.includes('could not be stored')));
});

test('a limit that cannot be read answers a JSON error, never the default page', async (t) => {
  const { call } = await setUp(t, { settings: { read: async () => { throw new Error('damaged'); }, update: async () => ({}) } });
  assert.deepEqual(await call('GET', '/api/mittr/voice/settings'), { status: 500, body: { error: 'Could not read the voice settings' } });
});

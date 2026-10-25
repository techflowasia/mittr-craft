import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { serve } from './test-helpers.js';
import { registerAppearanceSettingsRoutes } from './appearance-settings-routes.js';

const ROUTE = '/api/mittr/appearance/settings';

const quietLogger = () => {
  const lines = [];
  const record = (...args) => lines.push(args.join(' '));
  return { lines, log: record, warn: record, error: record };
};

const fakeSettings = ({ sidebarSide = 'left', failWith = null } = {}) => {
  let current = sidebarSide;
  const updates = [];
  return {
    updates,
    read: async () => ({ sidebarSide: current }),
    update: async (patch) => {
      updates.push(patch);
      if (failWith) throw failWith;
      current = patch.sidebarSide;
      return { sidebarSide: current };
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
  registerAppearanceSettingsRoutes(app, { express, host, requestScope: () => scope, mittrSettings: settings, logger });
  return { call: await serve(t, app), settings, logger };
};

test('GET answers the stored sidebar side and whether this request may change it', async (t) => {
  const { call } = await setUp(t);
  assert.deepEqual(await call('GET', ROUTE), { status: 200, body: { sidebarSide: 'left', canChange: true } });

  const stored = await setUp(t, { settings: fakeSettings({ sidebarSide: 'right' }) });
  assert.deepEqual((await stored.call('GET', ROUTE)).body, { sidebarSide: 'right', canChange: true });

  for (const [options, label] of [
    [{ scope: 'tunnel' }, 'a tunnel request'],
    [{ scope: 'remote' }, 'a remote request'],
    [{ peer: '192.0.2.7' }, 'a peer that is not loopback'],
    [{ host: null }, 'no desktop host'],
  ]) {
    const { call: other } = await setUp(t, options);
    assert.deepEqual((await other('GET', ROUTE)).body, { sidebarSide: 'left', canChange: false }, label);
  }
});

test('PUT stores the side', async (t) => {
  const { call, settings } = await setUp(t);
  assert.deepEqual(await call('PUT', ROUTE, { sidebarSide: 'right' }), { status: 200, body: { sidebarSide: 'right', canChange: true } });
  assert.deepEqual(await call('PUT', ROUTE, { sidebarSide: 'left' }), { status: 200, body: { sidebarSide: 'left', canChange: true } });
  assert.deepEqual(settings.updates, [{ sidebarSide: 'right' }, { sidebarSide: 'left' }]);
});

test('any other body answers 400 and stores nothing', async (t) => {
  const { call, settings } = await setUp(t);
  const invalid = 'sidebarSide must be left or right';
  for (const body of [{ sidebarSide: 'top' }, { sidebarSide: '' }, { sidebarSide: null }, { sidebarSide: 'right', other: 1 }, {}, ['right']]) {
    assert.deepEqual(await call('PUT', ROUTE, body), { status: 400, body: { error: invalid } }, JSON.stringify(body));
  }
  assert.deepEqual(settings.updates, []);
  const oversized = await fetch(`${call.base}${ROUTE}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sidebarSide: 'right', pad: 'x'.repeat(9 * 1024) }),
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(settings.updates, []);
});

test('a forwarded request cannot change it', async (t) => {
  const refused = { status: 403, body: { error: 'These settings can be changed only on this Mac' } };
  for (const [options, headers] of [
    [{ scope: 'tunnel' }, {}],
    [{ scope: 'remote' }, {}],
    [{ peer: '192.0.2.7' }, {}],
    [{ host: null }, {}],
    [{}, { 'x-forwarded-for': '198.51.100.4' }],
    [{}, { forwarded: 'for=198.51.100.4' }],
  ]) {
    const { call, settings } = await setUp(t, options);
    const response = await fetch(`${call.base}${ROUTE}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ sidebarSide: 'right' }),
    });
    assert.deepEqual({ status: response.status, body: await response.json() }, refused, JSON.stringify({ options, headers }));
    assert.deepEqual(settings.updates, [], JSON.stringify({ options, headers }));
  }
});

test('a side that cannot be stored answers 500 without saying why', async (t) => {
  const { call, logger } = await setUp(t, { settings: fakeSettings({ failWith: new Error('EACCES: /secret/dir') }) });
  assert.deepEqual(await call('PUT', ROUTE, { sidebarSide: 'right' }), { status: 500, body: { error: 'Cannot store the sidebar setting on this machine' } });
  assert.ok(logger.lines.some((line) => line.includes('could not be stored')));
});

test('a side that cannot be read answers a JSON error, never the default page', async (t) => {
  const { call } = await setUp(t, { settings: { read: async () => { throw new Error('damaged'); }, update: async () => ({}) } });
  assert.deepEqual(await call('GET', ROUTE), { status: 500, body: { error: 'Could not read the sidebar setting' } });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { registerMittrQuotaRoutes } from './quota-routes.js';
import { serve } from './test-helpers.js';

const QUOTA = { weekStart: '2026-10-12T17:00:00.000Z', resetsAt: '2026-10-19T17:00:00.000Z', lines: [] };

const setUp = async (t, readMine) => {
  const app = express();
  registerMittrQuotaRoutes(app, { service: { readMine } });
  return serve(t, app);
};

test('GET /api/mittr/quota/me answers the service result', async (t) => {
  const call = await setUp(t, async () => QUOTA);
  assert.deepEqual(await call('GET', '/api/mittr/quota/me'), { status: 200, body: QUOTA });
});

test('GET /api/mittr/quota/me answers a read failure with its status and reason', async (t) => {
  const call = await setUp(t, async () => { throw Object.assign(new Error('x'), { reasonCode: 'not_signed_in', statusCode: 401 }); });
  assert.deepEqual(await call('GET', '/api/mittr/quota/me'), {
    status: 401,
    body: { error: 'Could not read this week’s quota', reasonCode: 'not_signed_in' },
  });
});

test('GET /api/mittr/quota/me answers an unexpected failure as upstream_failed without its message', async (t) => {
  const call = await setUp(t, async () => { throw new Error('secret detail'); });
  assert.deepEqual(await call('GET', '/api/mittr/quota/me'), {
    status: 502,
    body: { error: 'Could not read this week’s quota', reasonCode: 'upstream_failed' },
  });
});

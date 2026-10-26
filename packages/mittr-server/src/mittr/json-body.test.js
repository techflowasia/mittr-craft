import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { jsonBody } from './json-body.js';
import { listen } from './test-helpers.js';

const setUp = async (t, limit = '1kb') => {
  const app = express();
  app.post('/echo', jsonBody(express, { limit }), (req, res) => res.json({ received: req.body }));
  const base = await listen(t, app);
  return (body, contentType = 'application/json') => fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': contentType }, body });
};

test('a well-formed body reaches the route parsed', async (t) => {
  const post = await setUp(t);
  const response = await post(JSON.stringify({ a: 1 }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: { a: 1 } });
});

test('a malformed body answers what the routes answer today', async (t) => {
  const post = await setUp(t);
  const response = await post('{');
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Invalid request body' });
});

test('an oversized body answers 413 with the same error text', async (t) => {
  const post = await setUp(t, '1kb');
  const response = await post(JSON.stringify({ pad: 'x'.repeat(2048) }));
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'Invalid request body' });
});

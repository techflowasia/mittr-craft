import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CANNOT_REACH_MITTR, PLATFORM_TIMED_OUT, PLATFORM_TIMEOUT_MS, READ_FAILED, callPlatform, isTimeout, platformErrorText } from './platform.js';
import { fakeFetch, json } from './test-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceOf = (name) => fs.readFileSync(path.join(here, name), 'utf8');

const PLATFORM_CALLERS = ['auth-routes.js', 'audit-routes.js', 'catalog-routes.js', 'quota-service.js'];
const SHARED_CALLERS = ['work-routes.js', 'integrations-routes.js'];

const productionModules = () => fs.readdirSync(here)
  .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js') && name !== 'test-helpers.js');

test('the shared platform values', () => {
  assert.equal(PLATFORM_TIMEOUT_MS, 15_000);
  assert.equal(CANNOT_REACH_MITTR, 'Cannot reach Mittr');
  assert.equal(READ_FAILED, 'Could not read this week’s quota');
  assert.equal(PLATFORM_TIMED_OUT, 'Mittr platform request timed out');
});

test('the platform error text is the error unless that is a bare HTTP reason, then the message', () => {
  assert.equal(platformErrorText({ error: 'Invalid base URL' }), 'Invalid base URL');
  assert.equal(platformErrorText({ error: 'Invalid base URL', message: 'other' }), 'Invalid base URL');
  for (const reason of ['Bad Request', 'Unauthorized', 'forbidden', ' Not Found ', 'Conflict', 'Internal Server Error']) {
    assert.equal(platformErrorText({ statusCode: 400, error: reason, message: 'baseUrl must be a URL' }), 'baseUrl must be a URL', reason);
    assert.equal(platformErrorText({ error: reason }), null, reason);
  }
  assert.equal(platformErrorText({ message: 'Only a message' }), 'Only a message');
  assert.equal(platformErrorText({ error: '  ', message: '' }), null);
  assert.equal(platformErrorText({ message: ['a', 'b'] }), null);
  for (const body of [null, undefined, 'text', 7, ['x'], {}]) assert.equal(platformErrorText(body), null);
});

test('a timeout is a TimeoutError or an AbortError and nothing else', () => {
  assert.equal(isTimeout(new DOMException('slow', 'TimeoutError')), true);
  assert.equal(isTimeout(new DOMException('stop', 'AbortError')), true);
  assert.equal(isTimeout(new TypeError('fetch failed')), false);
  assert.equal(isTimeout(null), false);
});

test('every platform call uses the one timeout', () => {
  for (const name of PLATFORM_CALLERS) {
    const source = sourceOf(name);
    const calls = [...source.matchAll(/AbortSignal\.timeout\(([^)]*)\)/g)].map((match) => match[1].trim());
    assert.ok(calls.length > 0, `${name} makes a platform call with a timeout`);
    for (const argument of calls) {
      if (argument === 'PLATFORM_TIMEOUT_MS') continue;
      assert.equal(argument, 'timeoutMs', `${name} passes ${argument}`);
      assert.match(source, /timeoutMs = PLATFORM_TIMEOUT_MS/, `${name} defaults its timeout option to the shared one`);
    }
    assert.match(source, /import \{[^}]*PLATFORM_TIMEOUT_MS[^}]*\} from '\.\/platform\.js'/, name);
  }
});

test('the work and work tracking routes reach the platform only through callPlatform, which uses the one timeout', () => {
  assert.match(sourceOf('platform.js'), /AbortSignal\.timeout\(PLATFORM_TIMEOUT_MS\)/);
  for (const name of SHARED_CALLERS) {
    const source = sourceOf(name);
    assert.match(source, /callPlatform\(fetchImpl,/, name);
    assert.doesNotMatch(source, /AbortSignal\.timeout|fetchImpl\(/, name);
  }
});

test('callPlatform sends the token, a JSON body when there is one and the one timeout, and reads the reply', async () => {
  const fetchImpl = fakeFetch(() => json({ ok: true }));
  const got = await callPlatform(fetchImpl, 'https://p.example/x', { accessToken: 'at-1', method: 'PUT', body: { a: 1 } });
  assert.equal(got.response.status, 200);
  assert.deepEqual(got.body, { ok: true });
  const [call] = fetchImpl.calls;
  assert.equal(call.method, 'PUT');
  assert.deepEqual(call.headers, { authorization: 'Bearer at-1', 'content-type': 'application/json' });
  assert.deepEqual(call.body, { a: 1 });
  assert.ok(call.signal);

  const plain = fakeFetch(() => new Response('not json', { status: 200 }));
  const read = await callPlatform(plain, 'https://p.example/x', { accessToken: 'at-1' });
  assert.equal(read.body, null);
  assert.equal(plain.calls[0].method, 'GET');
  assert.deepEqual(plain.calls[0].headers, { authorization: 'Bearer at-1' });
  assert.equal(plain.calls[0].body, undefined);
});

test('callPlatform answers 504 for a timeout and 502 for anything else, never throwing', async () => {
  const slow = await callPlatform(async () => { throw new DOMException('slow', 'TimeoutError'); }, 'https://p.example/x', { accessToken: 'at' });
  assert.deepEqual(slow, { failure: { status: 504, error: PLATFORM_TIMED_OUT } });
  const down = await callPlatform(async () => { throw new TypeError('fetch failed'); }, 'https://p.example/x', { accessToken: 'at' });
  assert.deepEqual(down.failure, { status: 502, error: CANNOT_REACH_MITTR });
  assert.equal(down.cause.name, 'TypeError');
  const slowBody = await callPlatform(async () => ({ status: 200, ok: true, json: async () => { throw new DOMException('slow', 'TimeoutError'); } }), 'https://p.example/x', { accessToken: 'at' });
  assert.deepEqual(slowBody, { failure: { status: 504, error: PLATFORM_TIMED_OUT } });
});

test('no module defines its own platform timeout or platform messages', () => {
  for (const name of productionModules().filter((entry) => entry !== 'platform.js')) {
    const source = sourceOf(name);
    assert.doesNotMatch(source, /(?:const|let)\s+PLATFORM_TIMEOUT_MS\b/, `${name} defines the timeout`);
    assert.doesNotMatch(source, /(?:const|let)\s+(?:UNREACHABLE|READ_FAILED)\s*=/, `${name} defines a platform message`);
    assert.equal(source.includes('Cannot reach Mittr'), false, `${name} spells the unreachable message`);
    assert.equal(source.includes('Could not read this week’s quota'), false, `${name} spells the quota read message`);
  }
});

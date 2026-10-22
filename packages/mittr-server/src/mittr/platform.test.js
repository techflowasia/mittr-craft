import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ACCOUNT_CHANGED, BROWSER_STEP_TIMEOUT_MS, CANNOT_REACH_MITTR, PLATFORM_CANCELLED, PLATFORM_TIMED_OUT, PLATFORM_TIMEOUT_MS, READ_FAILED, SPEECH_READINESS_TIMEOUT_MS, SPEECH_TIMEOUT_MS, VOICE_STEP_TIMEOUT_MS, callPlatform, isTimeout, platformErrorText } from './platform.js';
import { fakeFetch, json } from './test-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceOf = (name) => fs.readFileSync(path.join(here, name), 'utf8');

const PLATFORM_CALLERS = ['auth-routes.js', 'audit-routes.js', 'catalog-routes.js', 'quota-service.js'];
const SHARED_CALLERS = ['work-routes.js', 'integrations-routes.js', 'tools/browser-stepper.js', 'tools/work-lookup.js'];

const STREAMING_CALLERS = {
  'voice/speech-client.js': ['SPEECH_READINESS_TIMEOUT_MS', 'SPEECH_TIMEOUT_MS'],
  'voice/loop.js': ['VOICE_STEP_TIMEOUT_MS'],
};

const productionModules = () => ['', 'tools', 'voice'].flatMap((folder) => fs.readdirSync(path.join(here, folder))
  .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js') && name !== 'test-helpers.js')
  .map((name) => path.posix.join(folder, name)));

test('the shared platform values', () => {
  assert.equal(PLATFORM_TIMEOUT_MS, 15_000);
  assert.equal(CANNOT_REACH_MITTR, 'Cannot reach Mittr');
  assert.equal(READ_FAILED, 'Could not read this week’s quota');
  assert.equal(PLATFORM_TIMED_OUT, 'Mittr platform request timed out');
  assert.equal(BROWSER_STEP_TIMEOUT_MS, 30_000);
  assert.equal(PLATFORM_CANCELLED, 'The Mittr platform request was cancelled');
  assert.equal(ACCOUNT_CHANGED, 'The Mittr account changed');
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

test('the work, work tracking, browser step and card lookup callers reach the platform only through callPlatform, which uses the one timeout unless told otherwise', () => {
  assert.match(sourceOf('platform.js'), /AbortSignal\.timeout\(timeoutMs\)/);
  assert.match(sourceOf('platform.js'), /timeoutMs = PLATFORM_TIMEOUT_MS/);
  assert.match(sourceOf('tools/browser-stepper.js'), /timeoutMs = BROWSER_STEP_TIMEOUT_MS/);
  assert.doesNotMatch(sourceOf('tools/browser-stepper.js'), /30_?000/);
  assert.doesNotMatch(sourceOf('tools/work-lookup.js'), /timeoutMs|TIMEOUT_MS/);
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

test('callPlatform takes its own timeout and the caller\'s signal, and a cancelled call is not a timeout', async () => {
  const waiting = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  const started = Date.now();
  assert.deepEqual(await callPlatform(waiting, 'https://p.example/x', { accessToken: 'at', timeoutMs: 20 }), { failure: { status: 504, error: PLATFORM_TIMED_OUT } });
  assert.ok(Date.now() - started < PLATFORM_TIMEOUT_MS);
  const controller = new AbortController();
  const cancelled = callPlatform(waiting, 'https://p.example/x', { accessToken: 'at', signal: controller.signal });
  controller.abort();
  assert.deepEqual(await cancelled, { failure: { status: 499, error: PLATFORM_CANCELLED } });
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

test('the speech and voice platform timeouts', () => {
  assert.equal(SPEECH_READINESS_TIMEOUT_MS, 10_000);
  assert.equal(SPEECH_TIMEOUT_MS, 60_000);
  assert.equal(VOICE_STEP_TIMEOUT_MS, 120_000);
});

test('every streaming platform caller imports its timeout and uses only it', () => {
  for (const [name, constants] of Object.entries(STREAMING_CALLERS)) {
    const source = sourceOf(name);
    const calls = [...source.matchAll(/AbortSignal\.timeout\(([^)]*)\)/g)].map((match) => match[1].trim());
    assert.ok(calls.length > 0, `${name} makes a platform call with a timeout`);
    for (const argument of calls) assert.ok(constants.includes(argument), `${name} passes ${argument}`);
    for (const constant of constants) {
      assert.match(source, new RegExp(`import \\{[^}]*\\b${constant}\\b[^}]*\\} from '\\.\\./platform\\.js'`), `${name} imports ${constant}`);
    }
    assert.doesNotMatch(source, /\b(?:10_?000|60_?000|120_?000)\b/, `${name} spells a timeout`);
  }
});

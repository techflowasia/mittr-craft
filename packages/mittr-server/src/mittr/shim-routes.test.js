import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import express from 'express';

import { EventEmitter } from 'node:events';

import { SHIM_PREFIX, drained, registerMittrShim, sessionIdOf } from './shim-routes.js';
import { deferred, listen } from './test-helpers.js';

const LOCAL_TOKEN = `mc_local_${'ab'.repeat(32)}`;
const SESSION = { accessToken: 'at-1', refreshToken: 'r1', expiresAt: Date.now() + 3_600_000, subject: { userId: 'u-a', displayName: 'A' } };
const REQUEST = { model: 'gpt-a', stream: true, messages: [{ role: 'user', content: 'hi' }] };

const frame = (delta) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;
const DONE = 'data: [DONE]\n\n';
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const recordingLogger = () => {
  const lines = { log: [], warn: [], error: [] };
  return {
    lines,
    log: (...args) => lines.log.push(args.join(' ')),
    warn: (...args) => lines.warn.push(args.join(' ')),
    error: (...args) => lines.error.push(args.join(' ')),
  };
};

/** The platform, played by a loopback server that records every request it gets. */
const platform = async (t, respond) => {
  const requests = [];
  const base = await listen(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const request = { method: req.method, url: req.url, headers: req.headers, text, body: text ? JSON.parse(text) : undefined };
    requests.push(request);
    await respond(req, res, request);
  });
  return { v1: `${base}/v1`, requests };
};

const answerJson = (status, body, headers = {}) => (_req, res) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const answerStream = (frames) => async (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const piece of frames) res.write(piece);
  res.end();
};

/**
 * The shim on an express app shaped like the server's: JSON is parsed for
 * every path outside `/api` before plugin routes run. `peer.address` stands
 * in for the socket's remote address, which a test cannot choose.
 */
const shim = async (t, {
  upstreamV1 = 'http://127.0.0.1:9/v1',
  ensureFreshSession = async () => SESSION,
  ...options
} = {}) => {
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
  const handle = registerMittrShim(app, { upstreamV1, localToken: LOCAL_TOKEN, ensureFreshSession, ...options });
  const base = await listen(t, app);
  const request = (route, { method = 'POST', body = REQUEST, headers = {}, token = LOCAL_TOKEN, signal } = {}) => {
    const sent = new Headers();
    if (method === 'POST') sent.set('content-type', 'application/json');
    if (token) sent.set('authorization', `Bearer ${token}`);
    for (const [name, value] of Object.entries(headers)) sent.set(name, value);
    return fetch(`${base}${SHIM_PREFIX}${route}`, {
      method,
      headers: sent,
      body: method === 'POST' ? JSON.stringify(body) : undefined,
      signal,
    });
  };
  return { peer, request, handle };
};

const readAll = async (response) => Buffer.from(await response.arrayBuffer()).toString('utf8');

test('forwards with the account token and streams chunks as they arrive', async (t) => {
  const firstReceived = deferred();
  let secondSentAt = 0;
  const upstream = await platform(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame({ content: 'Hel' }));
    await Promise.race([firstReceived.promise, pause(2_000)]);
    await pause(100);
    secondSentAt = performance.now();
    res.write(frame({ content: 'lo' }));
    res.end(DONE);
  });
  const { request } = await shim(t, { upstreamV1: upstream.v1 });

  const response = await request('/chat/completions');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');
  assert.equal(response.headers.get('x-accel-buffering'), 'no');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  const firstAt = performance.now();
  firstReceived.resolve();
  let text = decoder.decode(first.value, { stream: true });
  assert.equal(text, frame({ content: 'Hel' }));
  for (let next = await reader.read(); !next.done; next = await reader.read()) text += decoder.decode(next.value, { stream: true });

  assert.ok(firstAt < secondSentAt, `chunk 1 reached the engine at ${firstAt}, after chunk 2 left at ${secondSentAt}`);
  assert.equal(text, frame({ content: 'Hel' }) + frame({ content: 'lo' }) + DONE);

  assert.equal(upstream.requests.length, 1);
  const [sent] = upstream.requests;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, '/v1/chat/completions');
  assert.equal(sent.headers.authorization, 'Bearer at-1');
  assert.deepEqual(sent.body, REQUEST);
});

test('the upstream request carries the Mittr token and never the local token', async (t) => {
  const upstream = await platform(t, answerStream([frame({ content: 'ok' }), DONE]));
  const { request } = await shim(t, { upstreamV1: upstream.v1 });
  await readAll(await request('/chat/completions', { headers: { 'x-opencode-session-id': 'ses_1', 'x-api-key': LOCAL_TOKEN } }));

  const [sent] = upstream.requests;
  assert.equal(sent.headers.authorization, 'Bearer at-1');
  assert.equal(JSON.stringify(sent.headers).includes(LOCAL_TOKEN), false);
  assert.equal(sent.text.includes(LOCAL_TOKEN), false);
  assert.equal(sent.headers['x-api-key'], undefined);
});

test('refuses a non-loopback peer', async (t) => {
  const upstream = await platform(t, answerStream([DONE]));
  let sessionReads = 0;
  const { peer, request } = await shim(t, { upstreamV1: upstream.v1, ensureFreshSession: async () => { sessionReads += 1; return SESSION; } });
  peer.address = '10.0.0.5';

  for (const [route, method] of [['/chat/completions', 'POST'], ['/models', 'GET'], ['/embeddings', 'POST']]) {
    const response = await request(route, { method });
    assert.equal(response.status, 403, route);
  }
  assert.equal(upstream.requests.length, 0);
  assert.equal(sessionReads, 0);

  peer.address = '::ffff:127.0.0.1';
  assert.equal((await request('/models', { method: 'GET' })).status, 200);
});

test('refuses a request a tunnel or proxy relayed, even from loopback', async (t) => {
  const upstream = await platform(t, answerStream([DONE]));
  const { request } = await shim(t, { upstreamV1: upstream.v1 });
  for (const header of ['x-forwarded-for', 'cf-connecting-ip', 'forwarded']) {
    const response = await request('/chat/completions', { headers: { [header]: '203.0.113.9' } });
    assert.equal(response.status, 403, header);
  }
  assert.equal(upstream.requests.length, 0);
});

test('refuses a wrong local token', async (t) => {
  const upstream = await platform(t, answerStream([DONE]));
  let sessionReads = 0;
  const { request } = await shim(t, { upstreamV1: upstream.v1, ensureFreshSession: async () => { sessionReads += 1; return SESSION; } });

  const wrong = [
    { token: `mc_local_${'cd'.repeat(32)}` },
    { token: LOCAL_TOKEN.slice(0, -1) },
    { token: `${LOCAL_TOKEN}0` },
    { token: 'at-1' },
    { token: null },
    { token: null, headers: { authorization: `Basic ${LOCAL_TOKEN}` } },
  ];
  for (const options of wrong) {
    for (const [route, method] of [['/chat/completions', 'POST'], ['/models', 'GET']]) {
      const response = await request(route, { method, ...options });
      assert.equal(response.status, 401, `${route} ${JSON.stringify(options)}`);
      assert.deepEqual(await response.json(), { error: 'Unauthorized' });
    }
  }
  assert.equal(upstream.requests.length, 0);
  assert.equal(sessionReads, 0);
});

test('not signed in', async (t) => {
  const upstream = await platform(t, answerStream([DONE]));
  const { request } = await shim(t, { upstreamV1: upstream.v1, ensureFreshSession: async () => null });
  const response = await request('/chat/completions');
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Not signed in to Mittr. Sign in to continue.' });
  assert.equal(upstream.requests.length, 0);
});

test('a sign-in that cannot be read is answered as not signed in, not left hanging', async (t) => {
  const upstream = await platform(t, answerStream([DONE]));
  const logger = recordingLogger();
  const { request } = await shim(t, { upstreamV1: upstream.v1, logger, ensureFreshSession: async () => { throw new Error('index unreadable'); } });
  const response = await request('/chat/completions');
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Not signed in to Mittr. Sign in to continue.' });
  assert.equal(upstream.requests.length, 0);
  assert.equal(logger.lines.error.length, 1);
});

test('upstream unreachable', async (t) => {
  const port = await new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = server.address();
      server.close(() => resolve(free));
    });
  });
  const upstreamV1 = `http://127.0.0.1:${port}/v1`;
  const { request } = await shim(t, { upstreamV1, logger: recordingLogger() });
  const response = await request('/chat/completions');
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'Cannot reach Mittr' });
  // A network blip may pass: the engine keeps its own retry here.
  assert.equal(response.headers.get('x-should-retry'), null);
});

test('an upstream that does not answer in time is given up on', async (t) => {
  const upstream = await platform(t, () => {});
  const { request } = await shim(t, { upstreamV1: upstream.v1, upstreamTimeoutMs: 150 });
  const response = await request('/chat/completions');
  assert.equal(response.status, 504);
  assert.equal(response.headers.get('x-should-retry'), 'false');
  assert.deepEqual(await response.json(), { error: 'Mittr did not answer in time' });
});

const ENGINE_INVALID_REQUEST_TYPES = new Set(['model_not_found', 'invalid_prompt', 'invalid_request', 'invalid_request_error', 'validationexception']);
const ENGINE_RETRY_WORDING = /\b(?:try again|(?:please |you can )?retry (?:the |this |your )?request|try (?:the |this |your )?request again|(?:currently |temporarily )?at capacity|overloaded|temporarily unavailable|service[-_\s]?unavailable|(?:server|internal)[-_\s]?error|server (?:is )?busy|provider returned (?:an )?error|resource[-_\s]?exhausted|upstream (?:connect|connection|request)|request buffer limit while retrying upstream)\b/i;

const assertEndsAsCutOff = (text) => {
  const events = text.split('\n\n').filter((event) => event.trim() !== '');
  assert.equal(`${events[0]}\n\n`, frame({ content: 'Hel' }));
  assert.equal(events.at(-1), 'data: [DONE]');
  const cut = JSON.parse(events.at(-2).trim().slice('data: '.length));
  assert.deepEqual(cut, { error: { type: 'invalid_request_error', code: 'stream_cut_off', message: 'The answer was cut off. Send your message again.' } });
  assert.ok(ENGINE_INVALID_REQUEST_TYPES.has(cut.error.type));
  assert.equal(ENGINE_RETRY_WORDING.test(cut.error.message), false);
  assert.equal(ENGINE_RETRY_WORDING.test(cut.error.code), false);
  assert.equal(events.length, 3);
};

test('a stream that goes quiet ends with one error the engine does not retry', async (t) => {
  const upstream = await platform(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame({ content: 'Hel' }));
  });
  const logger = recordingLogger();
  const { request } = await shim(t, { upstreamV1: upstream.v1, upstreamTimeoutMs: 150, logger });
  const response = await request('/chat/completions');
  assert.equal(response.status, 200);
  assertEndsAsCutOff(await readAll(response));
  assert.deepEqual(logger.lines.error, ['[mittr] shim cut the answer: Mittr went silent']);
  assert.equal(upstream.requests.length, 1);
});

test('a stream the platform breaks ends with one error the engine does not retry', async (t) => {
  const upstream = await platform(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame({ content: 'Hel' }));
    res.write('data: {"choices":[{"delta":{"content":"half a fr');
    await pause(20);
    req.socket.destroy();
  });
  const events = [];
  const { request } = await shim(t, { upstreamV1: upstream.v1, logger: recordingLogger(), onAnswer: (event) => events.push(event) });
  const response = await request('/chat/completions');
  const text = await readAll(response);
  assertEndsAsCutOff(text);
  assert.equal(text.includes('half a fr'), false);
  assert.equal(events.some((event) => event.done), false);
});

test('the engine hanging up stops the upstream request', async (t) => {
  const upstreamClosed = deferred();
  const upstream = await platform(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame({ content: 'Hel' }));
    res.on('close', () => upstreamClosed.resolve('closed'));
  });
  const { request } = await shim(t, { upstreamV1: upstream.v1 });
  const controller = new AbortController();
  const response = await request('/chat/completions', { signal: controller.signal });
  await response.body.getReader().read();
  controller.abort();
  assert.equal(await Promise.race([upstreamClosed.promise, pause(2_000).then(() => 'still open')]), 'closed');
});

test('a refusal from Mittr reaches the engine with its status, body and retry headers', async (t) => {
  const refusal = { error: { message: 'agent_not_granted', code: 'agent_not_granted' } };
  const upstream = await platform(t, (req, res, sent) => (sent.body.model === 'busy'
    ? answerJson(429, { error: { type: 'rate_limit_exceeded' } }, { 'retry-after': '3', 'x-should-retry': 'true' })(req, res)
    : answerJson(403, refusal)(req, res)));
  const { request } = await shim(t, { upstreamV1: upstream.v1 });

  const refused = await request('/chat/completions');
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get('content-type'), 'application/json');
  assert.deepEqual(await refused.json(), refusal);

  const limited = await request('/chat/completions', { body: { ...REQUEST, model: 'busy' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '3');
  assert.equal(limited.headers.get('x-should-retry'), 'true');
  assert.equal(upstream.requests.length, 2);
});

const QUOTA_BODY = { error: { type: 'insufficient_quota', code: 'llm_quota_exhausted', resets_at: '2026-10-20T00:00:00+07:00' } };

test('pre-stream 429 becomes 402 with x-should-retry false', async (t) => {
  const upstream = await platform(t, answerJson(429, QUOTA_BODY, { 'retry-after': '3' }));
  const events = [];
  const { request } = await shim(t, { upstreamV1: upstream.v1, onAnswer: (event) => events.push(event) });

  const response = await request('/chat/completions');
  assert.equal(response.status, 402);
  assert.equal(response.headers.get('x-should-retry'), 'false');
  assert.equal(response.headers.get('retry-after'), null);
  const body = await response.json();
  assert.equal(body.error.type, 'insufficient_quota');
  assert.equal(body.error.code, 'llm_quota_exhausted');
  assert.equal(body.error.message, 'Weekly model quota used up');
  assert.equal(body.error.resets_at, '2026-10-19T17:00:00.000Z');
  assert.equal(upstream.requests.length, 1);
  assert.deepEqual(events, []);
});

test('flat filter body is recognised', async (t) => {
  const upstream = await platform(t, answerJson(429, { code: 'llm_quota_exhausted', kind: 'chat', resetsAt: '2026-10-20T00:00:00+07:00' }));
  const { request } = await shim(t, { upstreamV1: upstream.v1 });

  const response = await request('/chat/completions', { body: { ...REQUEST, stream: false } });
  assert.equal(response.status, 402);
  assert.equal(response.headers.get('x-should-retry'), 'false');
  const body = await response.json();
  assert.equal(body.error.kind, 'chat');
  assert.equal(body.error.resets_at, '2026-10-19T17:00:00.000Z');
  assert.equal(upstream.requests.length, 1);
});

test('mid-stream quota frame is rewritten and the stream ends', async (t) => {
  const upstreamClosed = deferred();
  const upstream = await platform(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame({ content: 'Hel' }));
    res.write(`data: ${JSON.stringify(QUOTA_BODY)}\n\n${frame({ content: 'after the refusal' })}data: {"choices":[{"delta":{"content":"tail`);
    res.on('close', () => upstreamClosed.resolve('closed'));
  });
  const { request } = await shim(t, { upstreamV1: upstream.v1 });

  const response = await request('/chat/completions');
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const outcome = await Promise.race([
    (async () => {
      for (let next = await reader.read(); !next.done; next = await reader.read()) text += decoder.decode(next.value, { stream: true });
      return 'ended';
    })(),
    pause(2_000).then(() => 'still open'),
  ]);
  assert.equal(outcome, 'ended');

  const [first, refusal, ...rest] = text.split('\n\n');
  assert.equal(`${first}\n\n`, frame({ content: 'Hel' }));
  assert.ok(refusal.startsWith('data: {"error":{"type":"insufficient_quota","code":"llm_quota_exhausted","message":'), refusal);
  const payload = JSON.parse(refusal.slice('data: '.length));
  assert.equal(JSON.parse(payload.error.message).error.resets_at, '2026-10-19T17:00:00.000Z');
  assert.deepEqual(rest, ['data: [DONE]', '']);
  assert.equal(text.includes('after the refusal'), false);
  assert.equal(text.includes('tail'), false);
  assert.equal(await Promise.race([upstreamClosed.promise, pause(2_000).then(() => 'still open')]), 'closed');
  assert.equal(upstream.requests.length, 1);
});

test('a quota frame the platform ends on, with no line break, still ends the stream with [DONE]', async (t) => {
  const upstream = await platform(t, answerStream([frame({ content: 'Hel' }), `data: ${JSON.stringify(QUOTA_BODY)}`]));
  const { request } = await shim(t, { upstreamV1: upstream.v1 });

  const text = await readAll(await request('/chat/completions'));
  const [first, refusal, ...rest] = text.split('\n\n');
  assert.equal(`${first}\n\n`, frame({ content: 'Hel' }));
  assert.equal(JSON.parse(refusal.slice('data: '.length)).error.code, 'llm_quota_exhausted');
  assert.deepEqual(rest, ['data: [DONE]', '']);
});

test('a quota frame written in two parts is still rewritten and ends the stream', async (t) => {
  const refusal = `data: ${JSON.stringify(QUOTA_BODY)}\n\n`;
  const half = Math.floor(refusal.length / 2);
  const upstream = await platform(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame({ content: 'Hel' }));
    res.write(refusal.slice(0, half));
    await pause(50);
    res.write(refusal.slice(half));
  });
  const { request } = await shim(t, { upstreamV1: upstream.v1 });

  const text = await readAll(await request('/chat/completions'));
  const [first, rewritten, ...rest] = text.split('\n\n');
  assert.equal(`${first}\n\n`, frame({ content: 'Hel' }));
  assert.ok(rewritten.startsWith('data: {"error":{"type":"insufficient_quota","code":"llm_quota_exhausted","message":'), rewritten);
  assert.equal(JSON.parse(JSON.parse(rewritten.slice('data: '.length)).error.message).error.resets_at, '2026-10-19T17:00:00.000Z');
  assert.deepEqual(rest, ['data: [DONE]', '']);
});

test('a complete answer of 200 that carries a quota body becomes a 402', async (t) => {
  const upstream = await platform(t, answerJson(200, QUOTA_BODY));
  const events = [];
  const { request } = await shim(t, { upstreamV1: upstream.v1, onAnswer: (event) => events.push(event) });

  const response = await request('/chat/completions', { body: { ...REQUEST, stream: false } });
  assert.equal(response.status, 402);
  assert.equal(response.headers.get('x-should-retry'), 'false');
  assert.equal((await response.json()).error.resets_at, '2026-10-19T17:00:00.000Z');
  assert.deepEqual(events, []);
});

test('a plain rate limit is passed through', async (t) => {
  const limit = { error: { type: 'rate_limit_exceeded', code: 'rate_limit_exceeded', message: 'Slow down' } };
  const upstream = await platform(t, answerJson(429, limit, { 'retry-after': '1' }));
  const { request } = await shim(t, { upstreamV1: upstream.v1 });

  const response = await request('/chat/completions');
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('x-should-retry'), null);
  assert.equal(response.headers.get('retry-after'), '1');
  assert.deepEqual(await response.json(), limit);
});

test('a used-up agent picked outside the picker, at any effort, ends in one 402', async (t) => {
  const upstream = await platform(t, answerJson(429, QUOTA_BODY));
  const { request } = await shim(t, { upstreamV1: upstream.v1 });

  for (const reasoning_effort of [undefined, 'high']) {
    const response = await request('/chat/completions', { body: { ...REQUEST, model: 'used-up-agent', reasoning_effort } });
    assert.equal(response.status, 402);
    assert.equal(response.headers.get('x-should-retry'), 'false');
    assert.equal((await response.json()).error.code, 'llm_quota_exhausted');
  }
  assert.equal(upstream.requests.length, 2);
  assert.deepEqual(upstream.requests.map((sent) => sent.body.reasoning_effort ?? null), [null, 'high']);
});

test('a complete (non-streamed) answer is passed through whole', async (t) => {
  const answer = { id: 'c1', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }] };
  const upstream = await platform(t, answerJson(200, answer));
  const { request } = await shim(t, { upstreamV1: upstream.v1 });
  const response = await request('/chat/completions', { body: { ...REQUEST, stream: false } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), answer);
});

test('models lists the cached aliases', async (t) => {
  const { request } = await shim(t, { listModels: () => [{ alias: 'gpt-a', label: 'A' }] });
  const response = await request('/models', { method: 'GET' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, 'list');
  assert.equal(body.data[0].id, 'gpt-a');
  assert.deepEqual(body.data, [{ id: 'gpt-a', object: 'model' }]);

  const { request: empty } = await shim(t);
  assert.deepEqual(await (await empty('/models', { method: 'GET' })).json(), { object: 'list', data: [] });
});

test('a model list that cannot be read is an error, never an empty list', async (t) => {
  const { request } = await shim(t, { logger: recordingLogger(), listModels: () => { throw new Error('cache unreadable'); } });
  const response = await request('/models', { method: 'GET' });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-should-retry'), 'false');
});

test('a path the shim does not serve is answered here, behind the same guard', async (t) => {
  const { request } = await shim(t);
  assert.equal((await request('/embeddings')).status, 404);
  assert.equal((await request('/embeddings', { token: null })).status, 401);
});

test('the session header reaches onAnswer', async (t) => {
  const frames = [frame({ content: 'Hel' }), frame({ content: 'lo' }), DONE];
  const clock = { now: 1_800_000_000_000 };
  // Time moves on while Mittr answers; the events keep the time the request came in.
  const upstream = await platform(t, (req, res) => {
    clock.now += 5_000;
    return answerStream(frames)(req, res);
  });
  const events = [];
  const { request } = await shim(t, { upstreamV1: upstream.v1, now: () => clock.now, onAnswer: (event) => events.push(event) });

  await readAll(await request('/chat/completions', { headers: { 'x-opencode-session-id': 'ses_1', 'x-session-id': 'ses_other' } }));
  assert.ok(events.length >= 2);
  assert.ok(events.every((event) => event.sessionId === 'ses_1'));
  // The asked alias and when the request came in, for matching the answer to the engine's message.
  assert.ok(events.every((event) => event.model === 'gpt-a' && event.startedAt === 1_800_000_000_000), JSON.stringify(events.map(({ model, startedAt }) => ({ model, startedAt }))));
  assert.equal(events.at(-1).done, true);
  assert.ok(events.slice(0, -1).every((event) => event.done === false));
  assert.equal(Buffer.concat(events.slice(0, -1).map((event) => Buffer.from(event.chunk))).toString('utf8'), frames.join(''));

  events.length = 0;
  await readAll(await request('/chat/completions', { headers: { 'x-session-id': 'ses_2' } }));
  assert.ok(events.every((event) => event.sessionId === 'ses_2'));
  assert.equal(events.at(-1).done, true);

  events.length = 0;
  await readAll(await request('/chat/completions', { body: { ...REQUEST, model: 'gpt-a\nforged line' } }));
  assert.ok(events.length >= 2);
  assert.ok(events.every((event) => event.model === null && event.sessionId === null));
});

// How the engine's side of a stream ends within two seconds: cut, ended as if
// complete, or still open. A regression then fails instead of hanging.
const streamOutcome = async (reader) => Promise.race([
  (async () => {
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read());
      return 'ended';
    } catch {
      return 'cut';
    }
  })(),
  new Promise((resolve) => { setTimeout(() => resolve('still open'), 2_000); }),
]);

test('abortInFlight cuts an answer still streaming, and the upstream request with it', async (t) => {
  const upstreamClosed = deferred();
  const upstream = await platform(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame({ content: 'Hel' }));
    res.on('close', () => upstreamClosed.resolve('closed'));
  });
  const logger = recordingLogger();
  const { request, handle } = await shim(t, { upstreamV1: upstream.v1, logger });
  assert.equal(handle.abortInFlight(), 0);

  const response = await request('/chat/completions');
  const reader = response.body.getReader();
  await reader.read();
  assert.equal(handle.abortInFlight(), 1);
  assert.equal(await streamOutcome(reader), 'cut');
  assert.equal(await Promise.race([upstreamClosed.promise, pause(2_000).then(() => 'still open')]), 'closed');
  assert.equal(handle.abortInFlight(), 0);
  assert.deepEqual(logger.lines.warn, ['[mittr] shim ended 1 answer(s): the Mittr account changed']);

  // Finished answers are not held: a later cut finds nothing.
  const { request: again, handle: second } = await shim(t, { upstreamV1: (await platform(t, answerStream([DONE]))).v1 });
  await readAll(await again('/chat/completions'));
  assert.equal(second.abortInFlight(), 0);
});

test('waiting for the engine to drain ends when the engine has already gone', async () => {
  const gone = Object.assign(new EventEmitter(), { destroyed: true, writableEnded: false });
  await drained(gone);
  const ended = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: true });
  await drained(ended);
  const open = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false });
  const waiting = drained(open);
  open.emit('close');
  await waiting;
  assert.equal(open.listenerCount('drain') + open.listenerCount('close'), 0);
});

test('a complete answer reaches onAnswer as one chunk, and a refusal not at all', async (t) => {
  const answer = { choices: [{ message: { content: 'hi' } }], answered_by: { substituted: true } };
  const upstream = await platform(t, (req, res, sent) => (sent.body.model === 'refused'
    ? answerJson(403, { error: 'no' })(req, res)
    : answerJson(200, answer)(req, res)));
  const events = [];
  const { request } = await shim(t, { upstreamV1: upstream.v1, onAnswer: (event) => events.push(event) });

  await readAll(await request('/chat/completions', { body: { ...REQUEST, stream: false }, headers: { 'x-opencode-session-id': 'ses_1' } }));
  assert.deepEqual(events.map((event) => [event.sessionId, event.done]), [['ses_1', false], ['ses_1', true]]);
  assert.deepEqual(JSON.parse(Buffer.from(events[0].chunk).toString('utf8')), answer);

  events.length = 0;
  await readAll(await request('/chat/completions', { body: { ...REQUEST, model: 'refused' } }));
  assert.deepEqual(events, []);
});

test('a failing onAnswer never costs the engine its answer, and is logged once', async (t) => {
  const frames = [frame({ content: 'Hel' }), frame({ content: 'lo' }), DONE];
  const upstream = await platform(t, answerStream(frames));
  const logger = recordingLogger();
  const { request } = await shim(t, { upstreamV1: upstream.v1, logger, onAnswer: () => { throw new Error('boom'); } });
  assert.equal(await readAll(await request('/chat/completions')), frames.join(''));
  assert.equal(logger.lines.error.length, 1);
});

test('sessionIdOf reads the engine header first, then the fallback, and nothing malformed', () => {
  assert.equal(sessionIdOf({ 'x-opencode-session-id': 'ses_1', 'x-session-id': 'ses_2' }), 'ses_1');
  assert.equal(sessionIdOf({ 'x-session-id': ' ses_2 ' }), 'ses_2');
  assert.equal(sessionIdOf({ 'x-opencode-session-id': 'bad id\nforged line', 'x-session-id': 'ses_2' }), 'ses_2');
  assert.equal(sessionIdOf({}), null);
  assert.equal(sessionIdOf(undefined), null);
});

test('lost tool calls are logged once', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const answer = { choices: [{ index: 0, message: { role: 'assistant', content: '<tool_call>{}' } }] };
  const complete = await platform(t, answerJson(200, answer));
  const { request: completeShim } = await shim(t, { upstreamV1: complete.v1 });
  await readAll(await completeShim('/chat/completions', { body: { ...REQUEST, stream: false } }));
  assert.equal(errors.mock.callCount(), 1);
  assert.ok(errors.mock.calls[0].arguments.join(' ').includes('tool-calls-lost'));

  const streamed = await platform(t, answerStream([frame({ content: '<function=' }), frame({ content: 'bash>' }), DONE]));
  const { request: streamShim } = await shim(t, { upstreamV1: streamed.v1 });
  await readAll(await streamShim('/chat/completions'));
  assert.equal(errors.mock.callCount(), 2);
  assert.ok(errors.mock.calls[1].arguments.join(' ').includes('tool-calls-lost'));
});

test('the shim log names the call and never the token', async (t) => {
  const upstream = await platform(t, answerStream([frame({ content: 'plover' }), DONE]));
  const logger = recordingLogger();
  const { request } = await shim(t, { upstreamV1: upstream.v1, logger, env: { MITTRCRAFT_SHIM_LOG: '1' } });
  await readAll(await request('/chat/completions', { headers: { 'x-opencode-session-id': 'ses_1' } }));

  const lines = [...logger.lines.log, ...logger.lines.warn, ...logger.lines.error];
  assert.equal(lines.length, 1, lines.join('\n'));
  const [line] = lines;
  for (const part of ['POST', '/chat/completions', '200', 'ses_1']) assert.ok(line.includes(part), `${part} missing from ${line}`);
  assert.equal(line.includes('at-1'), false);
  assert.equal(line.includes(LOCAL_TOKEN), false);
  assert.equal(line.includes('plover'), false);
  assert.equal(line.includes('gpt-a'), false);

  const quiet = recordingLogger();
  const { request: unlogged } = await shim(t, { upstreamV1: upstream.v1, logger: quiet, env: {} });
  await readAll(await unlogged('/chat/completions'));
  assert.deepEqual(quiet.lines.log, []);
});

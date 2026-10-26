import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { listen, tempDataDir } from '../test-helpers.js';
import { pcm16ToWav } from './audio.js';
import { SpeechError } from './speech-client.js';
import { VOICE_KEYS_FILE, createSpeechKeys, mintSpeechKey } from './speech-key.js';
import { SPEECH_PREFIX, STT_KEY_SETTLE_MS, isSpeechCaller, registerSpeechRoutes } from './speech-routes.js';
import { createSpeechState } from './speech-state.js';

const ACCESS_TOKEN = 'at-secret-platform-token';

const recordingLogger = () => {
  const lines = [];
  const record = (...args) => lines.push(args.map(String).join(' '));
  return { lines, log: record, warn: record, error: record };
};

const fakeClient = ({ transcribe, synthesize, readiness } = {}) => {
  const calls = { transcribe: [], synthesize: [] };
  return {
    calls,
    readiness: readiness ?? (async () => ({ signedIn: true, ready: { listen: true, speak: true, voice: true }, voiceSilenceMs: 900, reason: null })),
    transcribe: async (wav, signal) => {
      calls.transcribe.push(wav);
      return transcribe ? transcribe(wav, signal) : 'heard you';
    },
    synthesize: async (text, signal) => {
      calls.synthesize.push(text);
      return synthesize ? synthesize(text, signal, calls.synthesize.length) : { audio: Buffer.from([1, 0, 2, 0]), contentType: 'audio/pcm;rate=24000' };
    },
  };
};

const serverLikeApp = () => {
  const app = express();
  const parseJson = express.json({ limit: '50mb' });
  app.use((req, res, next) => (req.path.startsWith('/api') ? next() : parseJson(req, res, next)));
  return app;
};

const setUp = async (t, { client = fakeClient(), offered = true, scope = 'local', host = {}, carried = false, dataDir = tempDataDir(t), port = 4100, upstream = {}, now = Date.now } = {}) => {
  const app = serverLikeApp();
  const keys = createSpeechKeys({ dataDir });
  const state = createSpeechState();
  t.after(() => state.close());
  const logger = recordingLogger();
  const carry = {
    carried,
    pending: async () => carry.carried,
    done: async () => { carry.carried = false; },
  };
  const upstreamSettings = { value: upstream, read: async () => upstreamSettings.value };
  registerSpeechRoutes(app, { express, client, keys, state, offered, requestScope: () => scope, host, port: () => port, carry, upstreamSettings, logger, now });
  const base = await listen(t, app);
  const send = async (method, route, { body, headers = {}, bearer = keys.current() } = {}) => {
    const init = { method, headers: { ...headers } };
    if (bearer) init.headers.authorization = `Bearer ${bearer}`;
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(base + route, init);
    const bytes = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, headers: response.headers, type, bytes, body: type.includes('json') ? JSON.parse(bytes.toString('utf8')) : null };
  };
  return { app, keys, state, logger, client, carry, dataDir, upstreamSettings, send };
};

const wavForm = (bytes = pcm16ToWav(Buffer.alloc(3200), 16000)) => {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', 'mittr');
  form.append('response_format', 'json');
  return form;
};

const speak = (input, extra = {}) => ({ input, model: 'mittr', voice: 'mittr', response_format: 'mp3', speed: 0.9, ...extra });

const quota = (kind, resetsAt = '2026-10-26T17:00:00Z') => new SpeechError('llm_quota_exhausted', 429, { kind, resetsAt });

test('the speech prefix is /mittr-speech/v1', () => {
  assert.equal(SPEECH_PREFIX, '/mittr-speech/v1');
});

test('a WAV is transcribed through the platform and answered as text', async (t) => {
  const wav = pcm16ToWav(Buffer.alloc(3200, 1), 16000);
  const { send, client } = await setUp(t);
  const answer = await send('POST', '/mittr-speech/v1/audio/transcriptions', { body: wavForm(wav) });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { text: 'heard you' });
  assert.deepEqual(client.calls.transcribe, [wav]);
});

test('a transcription without a file answers 400 in the OpenAI shape', async (t) => {
  const { send, client } = await setUp(t);
  const form = new FormData();
  form.append('model', 'mittr');
  const answer = await send('POST', '/mittr-speech/v1/audio/transcriptions', { body: form });
  assert.equal(answer.status, 400);
  assert.equal(answer.body.error.code, 'bad_request');
  assert.equal(answer.headers.get('x-should-retry'), 'false');
  assert.deepEqual(client.calls.transcribe, []);
});

test('a quota refusal answers 429 with x-should-retry false and the reset time in the text, and blocks stt in the state', async (t) => {
  const { send, state } = await setUp(t, { client: fakeClient({ transcribe: async () => { throw quota('stt'); } }) });
  const answer = await send('POST', '/mittr-speech/v1/audio/transcriptions', { body: wavForm() });
  assert.equal(answer.status, 429);
  assert.equal(answer.headers.get('x-should-retry'), 'false');
  assert.deepEqual(answer.body, {
    error: { type: 'insufficient_quota', code: 'llm_quota_exhausted', message: 'Voice input is out of quota until Tue 27 Oct, 00:00', resets_at: '2026-10-26T17:00:00Z' },
  });
  assert.equal(state.view().stt.blockedUntil, '2026-10-26T17:00:00Z');
  assert.equal(state.view().tts.blockedUntil, null);
});

test('a spoken-reply quota refusal says the reply goes to text, and blocks tts', async (t) => {
  const { send, state } = await setUp(t, { client: fakeClient({ synthesize: async () => { throw quota('tts', null); } }) });
  const answer = await send('POST', '/mittr-speech/v1/audio/speech', { body: speak('hello') });
  assert.equal(answer.status, 429);
  assert.equal(answer.body.error.message, 'Spoken replies are out of quota this week — answering in text');
  assert.equal(answer.body.error.code, 'llm_quota_exhausted');
  assert.ok(state.view().tts.blockedUntil);
});

test('a successful call clears the block', async (t) => {
  let refuse = true;
  const client = fakeClient({ transcribe: async () => { if (refuse) throw quota('stt'); return 'back'; } });
  const { send, state } = await setUp(t, { client });
  await send('POST', '/mittr-speech/v1/audio/transcriptions', { body: wavForm() });
  assert.ok(state.view().stt.blockedUntil);
  refuse = false;
  assert.deepEqual((await send('POST', '/mittr-speech/v1/audio/transcriptions', { body: wavForm() })).body, { text: 'back' });
  assert.equal(state.view().stt.blockedUntil, null);
});

test('every other refusal has its own sentence, readable behind a status code', async (t) => {
  const cases = [
    ['not_signed_in', 401, 'Sign in to Mittr to use dictation'],
    ['not_configured', 503, 'Your Mittr admin has not set up speech models yet'],
    ['unreachable', 502, 'The Mittr platform cannot be reached right now'],
    ['upstream_timeout', 504, 'The Mittr platform cannot be reached right now'],
    ['account_changed', 409, 'The Mittr account changed'],
  ];
  for (const [reasonCode, status, message] of cases) {
    const { send } = await setUp(t, { client: fakeClient({ transcribe: async () => { throw new SpeechError(reasonCode, status); } }) });
    const answer = await send('POST', '/mittr-speech/v1/audio/transcriptions', { body: wavForm() });
    assert.equal(answer.status, status, reasonCode);
    assert.equal(answer.body.error.code, reasonCode);
    assert.equal(answer.body.error.message, message, reasonCode);
    assert.equal(answer.headers.get('x-should-retry'), 'false');
  }
});

test('a transcription whose account changed during the call answers 409 and returns no text', async (t) => {
  const { send } = await setUp(t, { client: fakeClient({ transcribe: async () => { throw new SpeechError('account_changed', 409); } }) });
  const answer = await send('POST', '/mittr-speech/v1/audio/transcriptions', { body: wavForm() });
  assert.equal(answer.status, 409);
  assert.equal(Object.hasOwn(answer.body, 'text'), false);
});

test('a synthesis whose account changed after the platform answered sends no audio', async (t) => {
  const { send } = await setUp(t, { client: fakeClient({ synthesize: async () => { throw new SpeechError('account_changed', 409); } }) });
  const answer = await send('POST', '/mittr-speech/v1/audio/speech', { body: speak('hello') });
  assert.equal(answer.status, 409);
  assert.match(answer.type, /json/);
});

test('6000 characters are synthesized in two calls and played as one WAV', async (t) => {
  const sentence = 'This sentence is part of a long answer. ';
  const text = sentence.repeat(Math.ceil(6000 / sentence.length));
  const client = fakeClient({ synthesize: async (_text, _signal, count) => ({ audio: Buffer.from(count === 1 ? [1, 0, 2, 0] : [3, 0]), contentType: 'audio/pcm;rate=24000' }) });
  const { send } = await setUp(t, { client });
  const answer = await send('POST', '/mittr-speech/v1/audio/speech', { body: speak(text) });
  assert.equal(answer.status, 200);
  assert.equal(answer.type, 'audio/wav');
  assert.equal(client.calls.synthesize.length, 2);
  assert.ok(client.calls.synthesize.every((part) => part.length <= 4000));
  assert.deepEqual(answer.bytes, pcm16ToWav(Buffer.from([1, 0, 2, 0, 3, 0]), 24000));
  assert.equal(answer.headers.get('x-content-type-options'), 'nosniff');
});

test('24 kHz PCM is wrapped as WAV and L16 is byte-swapped first', async (t) => {
  const pcm = await setUp(t, { client: fakeClient({ synthesize: async () => ({ audio: Buffer.from([1, 2, 3, 4, 5]), contentType: 'audio/pcm' }) }) });
  assert.deepEqual((await pcm.send('POST', '/mittr-speech/v1/audio/speech', { body: speak('hi') })).bytes, pcm16ToWav(Buffer.from([1, 2, 3, 4]), 24000));
  const l16 = await setUp(t, { client: fakeClient({ synthesize: async () => ({ audio: Buffer.from([1, 2, 3, 4]), contentType: 'audio/L16;rate=16000' }) }) });
  assert.deepEqual((await l16.send('POST', '/mittr-speech/v1/audio/speech', { body: speak('hi') })).bytes, pcm16ToWav(Buffer.from([2, 1, 4, 3]), 16000));
});

test('one encoded part passes through with its own type, even when mp3 was asked for', async (t) => {
  for (const contentType of ['audio/wav', 'audio/mpeg']) {
    const { send } = await setUp(t, { client: fakeClient({ synthesize: async () => ({ audio: Buffer.from(`bytes of ${contentType}`), contentType }) }) });
    const answer = await send('POST', '/mittr-speech/v1/audio/speech', { body: speak('hello') });
    assert.equal(answer.status, 200);
    assert.equal(answer.type, contentType);
    assert.deepEqual(answer.bytes, Buffer.from(`bytes of ${contentType}`));
  }
});

test('audio this app cannot join or play answers 502 with 1.22\'s words', async (t) => {
  const long = 'x '.repeat(3000);
  const encoded = await setUp(t, { client: fakeClient({ synthesize: async () => ({ audio: Buffer.from('mp3'), contentType: 'audio/mpeg' }) }) });
  const joined = await encoded.send('POST', '/mittr-speech/v1/audio/speech', { body: speak(long) });
  assert.equal(joined.status, 502);
  assert.equal(joined.body.error.message, 'The Mittr platform returned audio this app cannot join');

  const stereo = await setUp(t, { client: fakeClient({ synthesize: async () => ({ audio: Buffer.from([1, 0, 2, 0]), contentType: 'audio/pcm;rate=24000;channels=2' }) }) });
  const played = await stereo.send('POST', '/mittr-speech/v1/audio/speech', { body: speak('hi') });
  assert.equal(played.status, 502);
  assert.equal(played.body.error.message, 'The Mittr platform returned audio this app cannot play');

  const silent = await setUp(t, { client: fakeClient({ synthesize: async () => ({ audio: Buffer.from('{}'), contentType: 'application/json' }) }) });
  assert.equal((await silent.send('POST', '/mittr-speech/v1/audio/speech', { body: speak('hi') })).status, 502);
});

test('a speech request without text, or with more than 64 000 characters, answers 400 and calls nothing', async (t) => {
  const { send, client } = await setUp(t);
  for (const input of ['', '   ', 7, 'x'.repeat(64_001)]) {
    const answer = await send('POST', '/mittr-speech/v1/audio/speech', { body: speak(input) });
    assert.equal(answer.status, 400, String(input).slice(0, 10));
    assert.equal(answer.body.error.code, 'bad_request');
  }
  assert.deepEqual(client.calls.synthesize, []);
});

test('a speech request from another machine or through a relay header answers 401', async (t) => {
  const { send, keys, client } = await setUp(t);
  const refused = { error: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'Not a MittrCraft speech key' } };
  for (const header of ['x-forwarded-for', 'forwarded', 'via', 'x-openchamber-relay-connection']) {
    const answer = await send('POST', '/mittr-speech/v1/audio/speech', { body: speak('hi'), headers: { [header]: '203.0.113.9' } });
    assert.equal(answer.status, 401, header);
    assert.deepEqual(answer.body, refused);
  }
  assert.equal(isSpeechCaller({ socket: { remoteAddress: '192.0.2.4' }, headers: { authorization: `Bearer ${keys.current()}` } }, keys), false);
  assert.equal(isSpeechCaller({ socket: { remoteAddress: '127.0.0.1' }, headers: { authorization: `Bearer ${keys.current()}` } }, keys), true);
  assert.deepEqual(client.calls.synthesize, []);
});

test('a request with the engine\'s shim key, another run\'s key or no key answers 401', async (t) => {
  const { send, client } = await setUp(t);
  for (const bearer of ['mc_local_0123456789abcdef', mintSpeechKey(), null]) {
    const answer = await send('POST', '/mittr-speech/v1/audio/transcriptions', { body: wavForm(), bearer });
    assert.equal(answer.status, 401, String(bearer));
    assert.equal(answer.body.error.code, 'invalid_api_key');
  }
  assert.deepEqual(client.calls.transcribe, []);
});

test('the speech key, the access token and the audio never reach a log line or a reply', async (t) => {
  const audio = Buffer.from('AUDIO-MARKER-BYTES');
  const client = fakeClient({
    transcribe: async () => { throw Object.assign(new SpeechError('upstream_failed', 502), { cause: ACCESS_TOKEN }); },
    synthesize: async () => { throw new SpeechError('unreachable', 502); },
  });
  const { send, keys, logger } = await setUp(t, { client });
  const replies = [
    await send('POST', '/mittr-speech/v1/audio/transcriptions', { body: wavForm(audio) }),
    await send('POST', '/mittr-speech/v1/audio/speech', { body: speak('SPOKEN-MARKER-TEXT') }),
    await send('GET', '/api/mittr/speech', { bearer: null }),
    await send('GET', '/api/mittr/voice/readiness', { bearer: null }),
    await send('PUT', '/api/mittr/speech/key', { body: { stt: true }, bearer: null }),
  ];
  const seen = [...logger.lines, ...replies.map((reply) => reply.bytes.toString('utf8'))].join('\n');
  for (const secret of [keys.current(), ACCESS_TOKEN, 'AUDIO-MARKER-BYTES', 'SPOKEN-MARKER-TEXT']) {
    assert.equal(seen.includes(secret), false, secret.slice(0, 12));
  }
  assert.ok(logger.lines.some((line) => line.includes('upstream_failed')));
});

test('readiness answers the 1.22 wire with here for this Mac only', async (t) => {
  const local = await setUp(t);
  assert.deepEqual((await local.send('GET', '/api/mittr/voice/readiness', { bearer: null })).body, {
    listen: true, speak: true, voice: true, signedIn: true, voiceSilenceMs: 900, reason: null, here: true,
  });
  assert.equal((await local.send('GET', '/api/mittr/voice/readiness', { bearer: null, headers: { 'x-forwarded-for': '203.0.113.9' } })).body.here, false);
  const tunnel = await setUp(t, { scope: 'tunnel' });
  assert.equal((await tunnel.send('GET', '/api/mittr/voice/readiness', { bearer: null })).body.here, false);

  const broken = await setUp(t, { client: fakeClient({ readiness: async () => { throw new Error('down'); } }) });
  assert.deepEqual((await broken.send('GET', '/api/mittr/voice/readiness', { bearer: null })).body, {
    listen: false, speak: false, voice: false, signedIn: false, voiceSilenceMs: null, reason: 'unreachable', here: true,
  });
  const missing = await setUp(t, { client: null });
  assert.equal((await missing.send('GET', '/api/mittr/voice/readiness', { bearer: null })).body.reason, 'unreachable');
});

test('the state long-poll answers when a block is added and when it lifts', async (t) => {
  const { send, state } = await setUp(t);
  const first = await send('GET', '/api/mittr/speech/state', { bearer: null });
  assert.deepEqual(first.body, { revision: 0, stt: { blockedUntil: null }, tts: { blockedUntil: null } });
  const waiting = send('GET', `/api/mittr/speech/state?since=${first.body.revision}`, { bearer: null });
  await new Promise((resolve) => setTimeout(resolve, 20));
  state.block('stt', new Date(Date.now() + 100).toISOString());
  const blocked = (await waiting).body;
  assert.ok(blocked.stt.blockedUntil);
  const lifted = (await send('GET', `/api/mittr/speech/state?since=${blocked.revision}`, { bearer: null })).body;
  assert.equal(lifted.stt.blockedUntil, null);
});

test('the speech settings say what is offered, where, and which kinds hold our key', async (t) => {
  const { send, dataDir, keys } = await setUp(t, { carried: true });
  assert.deepEqual((await send('GET', '/api/mittr/speech', { bearer: null })).body, {
    offered: true, baseUrl: 'http://127.0.0.1:4100/mittr-speech/v1', model: 'mittr', voice: 'mittr', installed: { stt: false, openaiCompatible: false }, carryDictation: true,
  });
  assert.deepEqual((await send('PUT', '/api/mittr/speech/key', { body: { stt: true }, bearer: null })).body, { installed: { stt: true, openaiCompatible: false } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, VOICE_KEYS_FILE), 'utf8')).stt, keys.current());
  assert.deepEqual((await send('PUT', '/api/mittr/speech/key', { body: { stt: false, openaiCompatible: true }, bearer: null })).body, { installed: { stt: false, openaiCompatible: true } });
  for (const body of [{}, { stt: 'yes' }, { tts: true }, []]) {
    assert.equal((await send('PUT', '/api/mittr/speech/key', { body, bearer: null })).status, 400, JSON.stringify(body));
  }
  assert.equal((await send('POST', '/api/mittr/speech/carried', { bearer: null })).status, 204);
  assert.equal((await send('GET', '/api/mittr/speech', { bearer: null })).body.carryDictation, false);
});

test('a server whose port is not known yet offers no Mittr speech either', async (t) => {
  const { send } = await setUp(t, { port: null, carried: true });
  assert.deepEqual((await send('GET', '/api/mittr/speech', { bearer: null })).body, {
    offered: false, baseUrl: null, model: 'mittr', voice: 'mittr', installed: { stt: false, openaiCompatible: false }, carryDictation: false,
  });
});

test('the speech key and the carry change only on this Mac', async (t) => {
  for (const options of [{ scope: 'tunnel' }, { host: null }]) {
    const { send, dataDir, carry } = await setUp(t, { carried: true, ...options });
    const key = await send('PUT', '/api/mittr/speech/key', { body: { stt: true }, bearer: null });
    assert.equal(key.status, 403);
    assert.deepEqual(key.body, { error: 'These settings can be changed only on this Mac' });
    assert.equal((await send('POST', '/api/mittr/speech/carried', { bearer: null })).status, 403);
    assert.equal(carry.carried, true);
    assert.equal(fs.existsSync(path.join(dataDir, VOICE_KEYS_FILE)), false);
  }
  const relayed = await setUp(t);
  assert.equal((await relayed.send('PUT', '/api/mittr/speech/key', { body: { stt: true }, bearer: null, headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 403);
});

test('a hosted runtime offers no Mittr speech', async (t) => {
  const { send, client } = await setUp(t, { offered: false, host: null });
  assert.deepEqual((await send('GET', '/api/mittr/speech', { bearer: null })).body, {
    offered: false, baseUrl: null, model: 'mittr', voice: 'mittr', installed: { stt: false, openaiCompatible: false }, carryDictation: false,
  });
  assert.equal((await send('POST', '/mittr-speech/v1/audio/speech', { body: speak('hi') })).status, 404);
  assert.equal((await send('POST', '/mittr-speech/v1/audio/transcriptions', { body: wavForm() })).status, 404);
  assert.deepEqual(client.calls, { transcribe: [], synthesize: [] });
  assert.equal((await send('GET', '/api/mittr/voice/readiness', { bearer: null })).body.here, false);
});

test('a dictation key just installed is not taken back before the new choice is saved', async (t) => {
  const clock = { at: 1_000_000 };
  const { send, keys, upstreamSettings } = await setUp(t, { upstream: { sttProvider: 'local', sttServerUrl: '' }, now: () => clock.at });
  assert.equal((await send('PUT', '/api/mittr/speech/key', { body: { stt: true }, bearer: null })).status, 200);
  clock.at += STT_KEY_SETTLE_MS - 1;
  assert.equal((await send('GET', '/api/mittr/speech', { bearer: null })).body.installed.stt, true);
  assert.equal(keys.installed().stt, true);
  clock.at += 2;
  assert.equal((await send('GET', '/api/mittr/speech', { bearer: null })).body.installed.stt, false);
  upstreamSettings.value = { sttProvider: 'openai-compatible', sttServerUrl: 'http://127.0.0.1:4100/mittr-speech/v1' };
  assert.equal((await send('PUT', '/api/mittr/speech/key', { body: { stt: true }, bearer: null })).status, 200);
  clock.at += STT_KEY_SETTLE_MS * 2;
  assert.equal((await send('GET', '/api/mittr/speech', { bearer: null })).body.installed.stt, true);
});

test('our dictation key is taken back once dictation no longer points at Mittr speech, and a person\'s own key never', async (t) => {
  const mittr = { sttProvider: 'openai-compatible', sttServerUrl: 'http://127.0.0.1:5999/mittr-speech/v1' };
  const { send, keys, upstreamSettings, dataDir } = await setUp(t, { upstream: mittr });
  keys.install(['stt', 'openaiCompatible']);
  assert.deepEqual((await send('GET', '/api/mittr/speech', { bearer: null })).body.installed, { stt: true, openaiCompatible: true });

  for (const moved of [{ sttProvider: 'local', sttServerUrl: mittr.sttServerUrl }, { sttProvider: 'openai-compatible', sttServerUrl: 'http://127.0.0.1:5999/v1' }, { sttProvider: 'openai-compatible', sttServerUrl: 'https://stt.example.test/mittr-speech/v1' }]) {
    keys.install(['stt']);
    upstreamSettings.value = moved;
    assert.deepEqual((await send('GET', '/api/mittr/speech', { bearer: null })).body.installed, { stt: false, openaiCompatible: true }, JSON.stringify(moved));
  }

  fs.writeFileSync(path.join(dataDir, VOICE_KEYS_FILE), JSON.stringify({ stt: 'person-own-key' }));
  await send('GET', '/api/mittr/speech', { bearer: null });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, VOICE_KEYS_FILE), 'utf8')).stt, 'person-own-key');
});

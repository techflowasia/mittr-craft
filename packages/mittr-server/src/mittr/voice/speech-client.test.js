import assert from 'node:assert/strict';
import test from 'node:test';

import { keyOf } from '../account-store.js';
import { SPEECH_READINESS_TIMEOUT_MS, SPEECH_TIMEOUT_MS } from '../platform.js';
import { SpeechError, createMittrSpeechClient } from './speech-client.js';

const BROKER = { baseUrl: 'https://api.example.test' };
const sessionOf = (userId, accessToken = `at-${userId}`) => ({ accessToken, subject: { userId } });

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const READY = { listen: { ready: true }, speak: { ready: true }, voice: { ready: true }, silenceMs: 1500, voiceSilenceMs: 900 };

const setUp = (respond, { user = 'u-a', now, session } = {}) => {
  const people = { active: user };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return respond({ url: String(url), init }, calls.length, people);
  };
  const client = createMittrSpeechClient({
    broker: BROKER,
    ensureFreshSession: async () => (session === undefined ? sessionOf(people.active) : session),
    activeAccountKey: () => (people.active ? keyOf(people.active) : null),
    fetchImpl,
    now: now ?? Date.now,
  });
  return { client, calls, people };
};

const speechError = (reasonCode, statusCode, extra = {}) => (error) => {
  assert.ok(error instanceof SpeechError, `expected a SpeechError, got ${error}`);
  assert.equal(error.reasonCode, reasonCode);
  assert.equal(error.statusCode, statusCode);
  for (const [key, value] of Object.entries(extra)) assert.equal(error[key], value, key);
  return true;
};

const WAV = Buffer.from('RIFF....WAVEfmt marker');

test('the client is absent without a platform, a session source or an account source', () => {
  const deps = { broker: BROKER, ensureFreshSession: async () => null, activeAccountKey: () => null };
  assert.equal(createMittrSpeechClient({ ...deps, broker: {} }), null);
  assert.equal(createMittrSpeechClient({ ...deps, ensureFreshSession: undefined }), null);
  assert.equal(createMittrSpeechClient({ ...deps, activeAccountKey: undefined }), null);
  assert.ok(createMittrSpeechClient(deps));
});

test('the speech timeouts are 10 seconds for readiness and 60 for speech', () => {
  assert.equal(SPEECH_READINESS_TIMEOUT_MS, 10_000);
  assert.equal(SPEECH_TIMEOUT_MS, 60_000);
});

test('a WAV is transcribed through the platform with the active account\'s bearer', async () => {
  const { client, calls } = setUp(() => json({ text: 'heard you' }));
  assert.equal(await client.transcribe(WAV, new AbortController().signal), 'heard you');
  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url, 'https://api.example.test/desktop/speech/transcribe');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer at-u-a');
  const audio = init.body.get('audio');
  assert.equal(audio.type, 'audio/wav');
  assert.equal(audio.name, 'audio.wav');
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), WAV);
});

test('empty_transcript gives an empty text', async () => {
  const { client } = setUp(() => json({ code: 'empty_transcript' }, 422));
  assert.equal(await client.transcribe(WAV), '');
  const blank = setUp(() => json({}));
  assert.equal(await blank.client.transcribe(WAV), '');
});

test('a 404 or a bare 503 reads as not configured, and the platform\'s own code keeps its meaning', async () => {
  for (const answer of [() => json({}, 404), () => json({}, 503), () => json({ code: 'not_configured' }, 409)]) {
    await assert.rejects(setUp(answer).client.transcribe(WAV), speechError('not_configured', 503));
  }
  await assert.rejects(setUp(() => json({ code: 'audio_too_large' }, 413)).client.transcribe(WAV), speechError('audio_too_large', 413));
  await assert.rejects(setUp(() => json({ code: 'odd_failure' }, 500)).client.synthesize('hi'), speechError('odd_failure', 500));
  await assert.rejects(setUp(() => json({}, 500)).client.synthesize('hi'), speechError('upstream_failed', 500));
});

test('a refused session, no session, an unreachable platform and a timeout each have their reason', async () => {
  await assert.rejects(setUp(() => json({}, 401)).client.transcribe(WAV), speechError('not_signed_in', 401));
  await assert.rejects(setUp(() => json({}, 403)).client.synthesize('hi'), speechError('not_signed_in', 401));
  const signedOut = setUp(() => json({ text: 'x' }), { session: null });
  await assert.rejects(signedOut.client.transcribe(WAV), speechError('not_signed_in', 401));
  assert.equal(signedOut.calls.length, 0);
  await assert.rejects(setUp(() => { throw new TypeError('fetch failed'); }).client.transcribe(WAV), speechError('unreachable', 502));
  await assert.rejects(setUp(() => { throw new DOMException('slow', 'TimeoutError'); }).client.transcribe(WAV), speechError('upstream_timeout', 504));
});

test('a quota body throws llm_quota_exhausted with its kind, reset and the platform status', async () => {
  const quota = { code: 'llm_quota_exhausted', kind: 'stt', resetsAt: '2026-10-26T17:00:00Z' };
  await assert.rejects(setUp(() => json(quota, 429)).client.transcribe(WAV), speechError('llm_quota_exhausted', 429, { kind: 'stt', resetsAt: '2026-10-26T17:00:00Z' }));
  await assert.rejects(setUp(() => json({ ...quota, kind: 'tts', resetsAt: null }, 402)).client.synthesize('hi'), speechError('llm_quota_exhausted', 402, { kind: 'tts', resetsAt: null }));
});

test('a transcription whose account changed during the call answers 409 and returns no text', async () => {
  const { client } = setUp((_call, _count, people) => {
    people.active = 'u-b';
    return json({ text: 'meant for A' });
  });
  await assert.rejects(client.transcribe(WAV), speechError('account_changed', 409));
});

test('a session that belongs to another account is not used', async () => {
  const { client, calls } = setUp(() => json({ text: 'x' }), { session: sessionOf('u-b') });
  await assert.rejects(client.transcribe(WAV), speechError('account_changed', 409));
  assert.equal(calls.length, 0);
});

test('a synthesis answers the platform\'s audio and its type', async () => {
  const { client, calls } = setUp(() => new Response(Buffer.from('mp3-bytes'), { headers: { 'content-type': 'audio/mpeg' } }));
  const spoken = await client.synthesize('สวัสดี hello');
  assert.deepEqual(spoken, { audio: Buffer.from('mp3-bytes'), contentType: 'audio/mpeg' });
  assert.equal(calls[0].url, 'https://api.example.test/desktop/speech/synthesize');
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'สวัสดี hello' });
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
});

test('a synthesis whose account changed after the platform answered sends no audio', async () => {
  const people = { active: 'u-a' };
  const body = new ReadableStream({
    pull(controller) {
      people.active = 'u-b';
      controller.enqueue(new TextEncoder().encode('audio for A'));
      controller.close();
    },
  });
  const client = createMittrSpeechClient({
    broker: BROKER,
    ensureFreshSession: async () => sessionOf('u-a'),
    activeAccountKey: () => keyOf(people.active),
    fetchImpl: async () => new Response(body, { headers: { 'content-type': 'audio/wav' } }),
  });
  await assert.rejects(client.synthesize('hi'), speechError('account_changed', 409));
});

test('a cancelled call stays a cancel', async () => {
  const controller = new AbortController();
  const { client } = setUp(async ({ init }) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) reject(init.signal.reason);
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }));
  const pending = client.transcribe(WAV, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
});

test('readiness reads the platform with the session and is kept 30 seconds per token', async () => {
  let clock = 1_000;
  const { client, calls, people } = setUp(() => json(READY), { now: () => clock });
  assert.deepEqual(await client.readiness(), { signedIn: true, ready: { listen: true, speak: true, voice: true }, silenceMs: 1500, voiceSilenceMs: 900, reason: null });
  assert.equal(calls[0].url, 'https://api.example.test/desktop/speech/readiness');
  assert.equal(calls[0].init.headers.authorization, 'Bearer at-u-a');
  clock += 29_000;
  await client.readiness();
  assert.equal(calls.length, 1);
  clock += 2_000;
  await client.readiness();
  assert.equal(calls.length, 2);
  people.active = 'u-b';
  await client.readiness();
  assert.equal(calls.length, 3);
});

test('readiness says why speech is not ready', async () => {
  assert.deepEqual(await setUp(() => json(READY), { session: null }).client.readiness(), { signedIn: false, ready: { listen: false, speak: false, voice: false }, reason: 'not_signed_in' });
  assert.equal((await setUp(() => json({}, 403)).client.readiness()).reason, 'not_signed_in');
  assert.equal((await setUp(() => json({ ...READY, voice: { ready: false } })).client.readiness()).reason, 'not_configured');
  assert.equal((await setUp(() => json({ code: 'not_configured' }, 409)).client.readiness()).reason, 'not_configured');
  assert.equal((await setUp(() => json({}, 404)).client.readiness()).reason, 'not_configured');
  assert.equal((await setUp(() => { throw new TypeError('down'); }).client.readiness()).reason, 'unreachable');
  assert.equal((await setUp(() => json({}, 500)).client.readiness()).reason, 'unreachable');
});

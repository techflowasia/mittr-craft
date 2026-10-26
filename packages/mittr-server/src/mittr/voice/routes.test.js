import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { listen } from '../test-helpers.js';
import { createVoiceConversation } from './conversation.js';
import { CONVERSATION_HEADER, THIS_MAC_ONLY, readTurnBody, registerVoiceRoutes } from './routes.js';
import { SpeechError } from './speech-client.js';
import { createSpeechState } from './speech-state.js';

const recordingLogger = () => {
  const lines = [];
  const record = (...args) => lines.push(args.map(String).join(' '));
  return { lines, log: record, warn: record, error: record };
};

const setUp = async (t, { scope = 'local', host = {}, client, runTurn } = {}) => {
  const app = express();
  const conversation = createVoiceConversation();
  const state = createSpeechState();
  t.after(() => state.close());
  const turns = [];
  const logger = recordingLogger();
  const speech = client ?? {
    transcribe: async () => 'open the shop',
    synthesize: async () => ({ audio: Buffer.from('mp3-bytes'), contentType: 'audio/mpeg' }),
  };
  registerVoiceRoutes(app, {
    express,
    conversation,
    state,
    client: speech,
    requestScope: () => scope,
    host,
    logger,
    runTurn: runTurn ?? (async (turn) => {
      turns.push(turn);
      turn.emit({ type: 'text-delta', text: 'ok' });
      turn.emit({ type: 'done' });
    }),
  });
  const base = await listen(t, app);
  const post = async (route, body, headers = {}) => {
    const init = { method: 'POST', headers: { ...headers } };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(base + route, init);
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, type: response.headers.get('content-type'), headers: response.headers, text, body: json };
  };
  return { post, conversation, state, turns, logger };
};

const audioForm = () => {
  const form = new FormData();
  form.append('audio', new Blob([Buffer.from('RIFF....WAVE')], { type: 'audio/wav' }), 'audio.wav');
  return form;
};

const turnBody = (conversationId, heard, extra = {}) => ({ said: 'open the shop', history: [], locale: 'en', conversationId, heard, ...extra });

test('every voice route answers 403 to a forwarded or tunnelled request', async (t) => {
  for (const options of [{ scope: 'tunnel' }, { host: null }]) {
    const { post } = await setUp(t, options);
    for (const route of ['/api/mittr/voice/start', '/api/mittr/voice/end', '/api/mittr/voice/transcribe', '/api/mittr/voice/synthesize', '/api/mittr/voice/turn']) {
      const answer = await post(route, {});
      assert.equal(answer.status, 403, `${JSON.stringify(options)} ${route}`);
      assert.deepEqual(answer.body, { error: THIS_MAC_ONLY });
    }
  }
  const { post } = await setUp(t);
  assert.equal((await post('/api/mittr/voice/start', undefined, { 'x-forwarded-for': '203.0.113.9' })).status, 403);
});

test('a transcription in the live conversation answers its text and a receipt the turn must bring back', async (t) => {
  const { post, turns } = await setUp(t);
  const { conversationId } = (await post('/api/mittr/voice/start')).body;
  const heard = await post('/api/mittr/voice/transcribe', audioForm(), { [CONVERSATION_HEADER]: conversationId });
  assert.equal(heard.status, 200);
  assert.equal(heard.body.text, 'open the shop');
  const turn = await post('/api/mittr/voice/turn', turnBody(conversationId, heard.body.heard));
  assert.equal(turn.status, 200);
  assert.match(turn.type, /text\/event-stream/);
  assert.equal(turn.text, 'data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"done"}\n\n');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].conversationId, conversationId);
  assert.equal(Object.hasOwn(turns[0], 'heard'), false);

  const reused = await post('/api/mittr/voice/turn', turnBody(conversationId, heard.body.heard));
  assert.deepEqual([reused.status, reused.body], [409, { error: 'not_heard', reasonCode: 'not_heard' }]);
});

test('a turn without a fresh heard receipt answers 409 and runs nothing', async (t) => {
  const { post, turns, conversation } = await setUp(t);
  const { conversationId } = (await post('/api/mittr/voice/start')).body;
  assert.deepEqual((await post('/api/mittr/voice/turn', turnBody(conversationId, 'made-up'))).body, { error: 'not_heard', reasonCode: 'not_heard' });
  const heard = conversation.hear(conversationId, 'something else');
  assert.deepEqual((await post('/api/mittr/voice/turn', turnBody(conversationId, heard))).body, { error: 'not_heard', reasonCode: 'not_heard' });
  assert.deepEqual((await post('/api/mittr/voice/turn', turnBody('another', 'x'))).body, { error: 'conversation_ended', reasonCode: 'conversation_ended' });
  assert.equal((await post('/api/mittr/voice/turn', { said: 'x' })).status, 400);
  assert.deepEqual(turns, []);
});

test('a transcription for an ended conversation answers 409', async (t) => {
  const { post } = await setUp(t);
  const { conversationId } = (await post('/api/mittr/voice/start')).body;
  assert.equal((await post('/api/mittr/voice/end', { conversationId })).status, 204);
  assert.deepEqual((await post('/api/mittr/voice/transcribe', audioForm(), { [CONVERSATION_HEADER]: conversationId })).body, { error: 'conversation_ended', reasonCode: 'conversation_ended' });
});

test('a transcript longer than 2000 characters, up to 4000, gets its turn with the receipt it was heard with', async (t) => {
  const long = `${'open the shop and read the report aloud '.repeat(62)}`.trim();
  assert.ok(long.length > 2000 && long.length <= 4000, String(long.length));
  const { post, turns } = await setUp(t, {
    client: { transcribe: async () => long, synthesize: async () => ({ audio: Buffer.from('x'), contentType: 'audio/mpeg' }) },
  });
  const { conversationId } = (await post('/api/mittr/voice/start')).body;
  const heard = await post('/api/mittr/voice/transcribe', audioForm(), { [CONVERSATION_HEADER]: conversationId });
  assert.equal(heard.body.text, long);
  const turn = await post('/api/mittr/voice/turn', turnBody(conversationId, heard.body.heard, { said: heard.body.text }));
  assert.equal(turn.status, 200);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].said, long);
  const tooLong = await post('/api/mittr/voice/turn', turnBody(conversationId, 'x', { said: 'a'.repeat(4001) }));
  assert.equal(tooLong.status, 400);
});

test('a speech refusal answers its status and reason, and a quota one blocks the state', async (t) => {
  const client = {
    transcribe: async () => { throw new SpeechError('llm_quota_exhausted', 429, { kind: 'stt', resetsAt: '2026-10-26T17:00:00Z' }); },
    synthesize: async () => { throw new SpeechError('not_configured'); },
  };
  const { post, state } = await setUp(t, { client });
  const { conversationId } = (await post('/api/mittr/voice/start')).body;
  const heard = await post('/api/mittr/voice/transcribe', audioForm(), { [CONVERSATION_HEADER]: conversationId });
  assert.deepEqual([heard.status, heard.body], [429, { error: 'Voice input is out of quota this week', reasonCode: 'llm_quota_exhausted', resetsAt: '2026-10-26T17:00:00Z' }]);
  assert.equal(state.view().stt.blockedUntil, '2026-10-26T17:00:00Z');
  const spoken = await post('/api/mittr/voice/synthesize', { text: 'hello' });
  assert.deepEqual([spoken.status, spoken.body], [503, { error: 'Your Mittr admin has not set up speech models yet', reasonCode: 'not_configured' }]);
});

test('synthesize answers the platform audio with its own type, and only 1 to 4000 characters', async (t) => {
  const { post } = await setUp(t);
  const spoken = await post('/api/mittr/voice/synthesize', { text: 'hello' });
  assert.equal(spoken.status, 200);
  assert.equal(spoken.type, 'audio/mpeg');
  assert.equal(spoken.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(spoken.text, 'mp3-bytes');
  for (const text of ['', 'x'.repeat(4001), 7]) assert.equal((await post('/api/mittr/voice/synthesize', { text })).status, 400);
});

test('a new turn aborts the running one, and ending the conversation aborts it too', async (t) => {
  const signals = [];
  const { post, conversation } = await setUp(t, {
    runTurn: (turn) => new Promise((resolve) => {
      signals.push(turn.signal);
      turn.signal.addEventListener('abort', resolve, { once: true });
    }),
  });
  const { conversationId } = (await post('/api/mittr/voice/start')).body;
  const first = post('/api/mittr/voice/turn', turnBody(conversationId, conversation.hear(conversationId, 'open the shop')));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = post('/api/mittr/voice/turn', turnBody(conversationId, conversation.hear(conversationId, 'open the shop')));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  await post('/api/mittr/voice/end', { conversationId });
  assert.equal(signals[1].aborted, true);
  await Promise.all([first, second]);
});

test('the turn body is 1.22\'s, with the conversation, the receipt and the panel', () => {
  const ok = readTurnBody({ said: ' hi ', history: [{ role: 'user', text: 'a', extra: 1 }], locale: 'th', directory: '/w', sessionId: 's', queuedPrompts: 3, conversationId: 'c', heard: 'h', panelOpen: true });
  assert.deepEqual(ok, { said: 'hi', history: [{ role: 'user', text: 'a' }], locale: 'th', directory: '/w', sessionId: 's', queuedPrompts: 3, conversationId: 'c', heard: 'h', panelOpen: true });
  for (const bad of [
    { said: 'x'.repeat(4001) }, { locale: 'jp' }, { history: Array.from({ length: 61 }, () => ({ role: 'user', text: 'a' })) },
    { history: [{ role: 'system', text: 'a' }] }, { queuedPrompts: 1001 }, { conversationId: '' }, { heard: undefined }, { panelOpen: 'yes' },
  ]) {
    assert.equal(readTurnBody({ said: 'hi', history: [], locale: 'en', conversationId: 'c', heard: 'h', ...bad }), null, JSON.stringify(bad).slice(0, 40));
  }
});

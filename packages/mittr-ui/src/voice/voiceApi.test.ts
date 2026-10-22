import { describe, expect, test } from 'bun:test';
import type { JsonValue } from '@openchamber/sdk';

import {
  HISTORY_LIMIT,
  TEXT_LIMIT,
  SynthesizeError,
  TranscribeError,
  VOICE_CONVERSATION_HEADER,
  VoiceStartError,
  createVoiceApi,
  isTalkReady,
  type VoiceFetch,
  type VoiceTurnEvent,
  type VoiceTurnRequest,
} from './voiceApi';

type FetchCall = { input: string; init: RequestInit | undefined };

function sse(parts: string[], status = 200) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    }),
    { status, headers: { 'content-type': 'text/event-stream' } },
  );
}

const line = (event: JsonValue) => `data: ${JSON.stringify(event)}\n\n`;

const json = (body: JsonValue, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fetchReturning(...responses: Response[]) {
  const calls: FetchCall[] = [];
  const impl: VoiceFetch = async (input, init) => {
    calls.push({ input, init });
    const next = responses.shift();
    if (!next) throw new Error('no response');
    return next;
  };
  return { impl, calls };
}

const bodyOf = (call: FetchCall | undefined) => JSON.parse(String(call?.init?.body));

async function collect(stream: AsyncIterable<VoiceTurnEvent>) {
  const out: VoiceTurnEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const rejection = <T,>(promise: Promise<T>) => promise.then(
  () => null,
  (cause: unknown) => cause,
);

const signal = () => new AbortController().signal;

const request = (patch: Partial<VoiceTurnRequest> = {}): VoiceTurnRequest => ({
  said: 'x',
  history: [],
  locale: 'en',
  conversationId: 'conv_1',
  heard: 'heard_1',
  ...patch,
});

describe('turn', () => {
  test('posts what was said with the last spoken turns, the locale, directory and session', async () => {
    const fake = fetchReturning(sse([line({ type: 'done' })]));
    const api = createVoiceApi(fake.impl);
    const history = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      text: `turn ${i}`,
    }));
    await collect(api.turn(request({ said: 'is it done', history, locale: 'th', directory: '/repo', sessionId: 's1' }), signal()));
    expect(fake.calls[0]?.input).toBe('/api/mittr/voice/turn');
    expect(fake.calls[0]?.init?.method).toBe('POST');
    const body = bodyOf(fake.calls[0]);
    expect(body.said).toBe('is it done');
    expect(body.locale).toBe('th');
    expect(body.directory).toBe('/repo');
    expect(body.sessionId).toBe('s1');
    expect(body.history).toHaveLength(HISTORY_LIMIT);
    expect(body.history[0].text).toBe('turn 5');
  });

  test('a turn carries the conversation and the receipt of its own transcription', async () => {
    const fake = fetchReturning(sse([line({ type: 'done' })]));
    await collect(createVoiceApi(fake.impl).turn(request({ conversationId: 'conv_7', heard: 'heard_42', panelOpen: true }), signal()));
    const body = bodyOf(fake.calls[0]);
    expect({ conversationId: body.conversationId, heard: body.heard, panelOpen: body.panelOpen }).toEqual({
      conversationId: 'conv_7',
      heard: 'heard_42',
      panelOpen: true,
    });
  });

  test('leaves directory, session and the panel out when there are none and clamps long text', async () => {
    const fake = fetchReturning(sse([line({ type: 'done' })]));
    const api = createVoiceApi(fake.impl);
    const long = 'a'.repeat(TEXT_LIMIT + 10);
    await collect(api.turn(request({ said: long, history: [{ role: 'user', text: long }] }), signal()));
    const body = bodyOf(fake.calls[0]);
    expect('directory' in body).toBe(false);
    expect('sessionId' in body).toBe(false);
    expect('panelOpen' in body).toBe(false);
    expect(body.said).toHaveLength(TEXT_LIMIT);
    expect(body.history[0].text).toHaveLength(TEXT_LIMIT);
  });

  test('reads text, running actions, tool results and done, even split mid-line', async () => {
    const whole =
      line({ type: 'text-delta', text: 'Opening Chrome.' }) +
      line({ type: 'tool-call', id: 'c1', name: 'mittrcraft_web', arguments: '{}' }) +
      line({ type: 'action', kind: 'running', label: 'Opening Chrome' }) +
      line({ type: 'tool-result', id: 'c1', ok: true }) +
      'data:{"type":"done"}\n\n';
    const fake = fetchReturning(sse([whole.slice(0, 17), whole.slice(17, 90), whole.slice(90)]));
    const events = await collect(createVoiceApi(fake.impl).turn(request({ said: 'open chrome' }), signal()));
    expect(events).toEqual([
      { type: 'text-delta', text: 'Opening Chrome.' },
      { type: 'action', kind: 'running', label: 'Opening Chrome' },
      { type: 'tool-result', id: 'c1', ok: true },
      { type: 'done' },
    ]);
  });

  test('passes through error codes, including not signed in and a changed account, and maps unknown ones to upstream_failed', async () => {
    const api = createVoiceApi(
      fetchReturning(
        sse([line({ type: 'error', code: 'not_signed_in' })]),
        sse([line({ type: 'error', code: 'upstream_timeout' })]),
        sse([line({ type: 'error', code: 'account_changed' })]),
        sse([line({ type: 'error', code: 'weird' })]),
      ).impl,
    );
    expect(await collect(api.turn(request(), signal()))).toEqual([{ type: 'error', code: 'not_signed_in' }]);
    expect(await collect(api.turn(request(), signal()))).toEqual([{ type: 'error', code: 'upstream_timeout' }]);
    expect(await collect(api.turn(request(), signal()))).toEqual([{ type: 'error', code: 'account_changed' }]);
    expect(await collect(api.turn(request(), signal()))).toEqual([{ type: 'error', code: 'upstream_failed' }]);
  });

  test('reads a queue event with its send config and sends the queued prompt count when it is known', async () => {
    const sendConfig = { providerID: 'mittr', modelID: 'acme-writer', agent: 'build', variant: 'high' };
    const fake = fetchReturning(
      sse([line({ type: 'queue', sessionId: 's1', directory: '/repo', text: 'run the tests', sendConfig }), line({ type: 'done' })]),
      sse([line({ type: 'done' })]),
    );
    const api = createVoiceApi(fake.impl);
    const events = await collect(api.turn(request({ said: 'run the tests', sessionId: 's1', directory: '/repo', queuedPrompts: 2 }), signal()));
    expect(events).toEqual([
      { type: 'queue', sessionId: 's1', directory: '/repo', text: 'run the tests', sendConfig },
      { type: 'done' },
    ]);
    expect(bodyOf(fake.calls[0]).queuedPrompts).toBe(2);
    await collect(api.turn(request(), signal()));
    expect('queuedPrompts' in bodyOf(fake.calls[1])).toBe(false);
  });

  test('a queue event without a usable send config still arrives, with none', async () => {
    const fake = fetchReturning(sse([line({ type: 'queue', sessionId: 's1', directory: '/repo', text: 'go', sendConfig: { providerID: '' } }), line({ type: 'done' })]));
    const events = await collect(createVoiceApi(fake.impl).turn(request(), signal()));
    expect(events[0]).toEqual({ type: 'queue', sessionId: 's1', directory: '/repo', text: 'go', sendConfig: null });
  });

  test('reads an end event', async () => {
    const fake = fetchReturning(sse([line({ type: 'end' }), line({ type: 'text-delta', text: 'Bye.' }), line({ type: 'done' })]));
    const events = await collect(createVoiceApi(fake.impl).turn(request({ said: 'bye' }), signal()));
    expect(events).toEqual([{ type: 'end' }, { type: 'text-delta', text: 'Bye.' }, { type: 'done' }]);
  });

  test('a refused request yields its error code from the body', async () => {
    const api = createVoiceApi(fetchReturning(json({ code: 'not_signed_in' }, 401), json({ error: 'conversation_ended' }, 409)).impl);
    expect(await collect(api.turn(request(), signal()))).toEqual([{ type: 'error', code: 'not_signed_in' }]);
    expect(await collect(api.turn(request(), signal()))).toEqual([{ type: 'error', code: 'upstream_failed' }]);
  });

  test('a stream that ends without done is a failure', async () => {
    const api = createVoiceApi(fetchReturning(sse([line({ type: 'text-delta', text: 'Hi' })])).impl);
    expect(await collect(api.turn(request(), signal()))).toEqual([
      { type: 'text-delta', text: 'Hi' },
      { type: 'error', code: 'upstream_failed' },
    ]);
  });
});

describe('synthesize', () => {
  test('asks for one sentence and returns the audio stream', async () => {
    const fake = fetchReturning(new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/wav' } }));
    const audio = await createVoiceApi(fake.impl).synthesize('Hello there.', signal());
    expect(fake.calls[0]?.input).toBe('/api/mittr/voice/synthesize');
    expect(bodyOf(fake.calls[0])).toEqual({ text: 'Hello there.' });
    expect(audio.contentType).toBe('audio/wav');
    expect(new Uint8Array(await new Response(audio.body).arrayBuffer())).toEqual(new Uint8Array([1, 2]));
  });

  test('fails on anything that is not audio', async () => {
    const api = createVoiceApi(fetchReturning(json({ error: 'x' }, 401), new Response('<html>', { headers: { 'content-type': 'text/html' } })).impl);
    expect(await rejection(api.synthesize('Hi.', signal()))).toBeInstanceOf(SynthesizeError);
    expect(await rejection(api.synthesize('Hi.', signal()))).toBeInstanceOf(SynthesizeError);
  });
});

describe('transcribe', () => {
  test('sends the WAV as the audio field for the conversation and returns the text and its receipt', async () => {
    const fake = fetchReturning(json({ text: ' open chrome ', heard: 'heard_1' }));
    const transcript = await createVoiceApi(fake.impl).transcribe(new Blob([new Uint8Array(4)], { type: 'audio/wav' }), 'conv_1', signal());
    expect(fake.calls[0]?.input).toBe('/api/mittr/voice/transcribe');
    expect(fake.calls[0]?.init?.method).toBe('POST');
    expect(new Headers(fake.calls[0]?.init?.headers).get(VOICE_CONVERSATION_HEADER)).toBe('conv_1');
    const form = fake.calls[0]?.init?.body;
    expect(form).toBeInstanceOf(FormData);
    if (form instanceof FormData) expect(form.get('audio')).toBeInstanceOf(Blob);
    expect(transcript).toEqual({ text: ' open chrome ', heard: 'heard_1' });
  });

  test('turns an error reply into a TranscribeError carrying the reason code', async () => {
    const api = createVoiceApi(fetchReturning(json({ error: 'no speech', reasonCode: 'empty_transcript' }, 422)).impl);
    const failure = await rejection(api.transcribe(new Blob([]), 'conv_1', signal()));
    expect(failure).toBeInstanceOf(TranscribeError);
    expect(failure).toMatchObject({ code: 'empty_transcript' });
  });

  test('a reply without a receipt is a failure', async () => {
    const api = createVoiceApi(fetchReturning(json({ text: 'hello' })).impl);
    expect(await rejection(api.transcribe(new Blob([]), 'conv_1', signal()))).toMatchObject({ code: 'upstream_failed' });
  });
});

describe('weekly quota', () => {
  const RESETS_AT = '2026-10-04T17:00:00.000Z';
  const refusal = () => json({ error: 'Mittr speech failed', reasonCode: 'llm_quota_exhausted', resetsAt: RESETS_AT }, 429);

  test('a refused transcription carries the reset time', async () => {
    const failure = await rejection(createVoiceApi(fetchReturning(refusal()).impl).transcribe(new Blob([]), 'conv_1', signal()));
    expect(failure).toBeInstanceOf(TranscribeError);
    expect(failure).toMatchObject({ code: 'llm_quota_exhausted', resetsAt: RESETS_AT });
  });

  test('a refused spoken reply carries the reset time', async () => {
    const failure = await rejection(createVoiceApi(fetchReturning(refusal()).impl).synthesize('Hi.', signal()));
    expect(failure).toBeInstanceOf(SynthesizeError);
    expect(failure).toMatchObject({ code: 'llm_quota_exhausted', resetsAt: RESETS_AT });
  });

  test('a refused voice step ends the turn with the quota error', async () => {
    const streamed = await collect(
      createVoiceApi(fetchReturning(sse([line({ type: 'error', code: 'llm_quota_exhausted', resetsAt: RESETS_AT })])).impl).turn(request({ said: 'hi' }), signal()),
    );
    expect(streamed).toEqual([{ type: 'error', code: 'llm_quota_exhausted', resetsAt: RESETS_AT }]);
    const refused = await collect(
      createVoiceApi(fetchReturning(json({ code: 'llm_quota_exhausted', resetsAt: RESETS_AT }, 429)).impl).turn(request({ said: 'hi' }), signal()),
    );
    expect(refused).toEqual([{ type: 'error', code: 'llm_quota_exhausted', resetsAt: RESETS_AT }]);
  });
});

describe('the conversation', () => {
  test('start answers the conversation the server opened', async () => {
    const fake = fetchReturning(json({ conversationId: 'conv_9' }));
    expect(await createVoiceApi(fake.impl).start()).toBe('conv_9');
    expect(fake.calls[0]?.input).toBe('/api/mittr/voice/start');
    expect(fake.calls[0]?.init?.method).toBe('POST');
  });

  test('a refused start throws', async () => {
    const failure = await rejection(createVoiceApi(fetchReturning(json({ error: 'The voice assistant can only be used on this Mac' }, 403)).impl).start());
    expect(failure).toBeInstanceOf(VoiceStartError);
    expect(failure).toMatchObject({ status: 403 });
  });

  test('ending the conversation calls end once with its id', async () => {
    const fake = fetchReturning(new Response(null, { status: 204 }));
    await createVoiceApi(fake.impl).end('conv_9');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.input).toBe('/api/mittr/voice/end');
    expect(fake.calls[0]?.init?.method).toBe('POST');
    expect(bodyOf(fake.calls[0])).toEqual({ conversationId: 'conv_9' });
  });

  test('end never throws when the server cannot be reached', async () => {
    const api = createVoiceApi(async () => {
      throw new Error('offline');
    });
    expect(await api.end('conv_9')).toBe(undefined);
  });
});

describe('readiness', () => {
  const READY = { listen: true, speak: true, voice: true, signedIn: true, here: true, voiceSilenceMs: 900, reason: null };

  test('reads the local readiness route', async () => {
    const fake = fetchReturning(json(READY));
    expect(await createVoiceApi(fake.impl).readiness()).toEqual(READY);
    expect(fake.calls[0]?.input).toBe('/api/mittr/voice/readiness');
  });

  test('a missing voice silence falls back to 900 ms', async () => {
    const ready = await createVoiceApi(fetchReturning(json({ ...READY, voiceSilenceMs: null })).impl).readiness();
    expect(ready?.voiceSilenceMs).toBe(900);
  });

  test('is null when the route fails or answers something else', async () => {
    const api = createVoiceApi(fetchReturning(new Response('nope', { status: 500 }), json({ listen: 1 }), json({ listen: true, speak: true, voice: true, signedIn: true, voiceSilenceMs: 900, reason: null })).impl);
    expect(await api.readiness()).toBeNull();
    expect(await api.readiness()).toBeNull();
    expect(await api.readiness()).toBeNull();
  });

  test('talk is ready only when listen, speak and voice are ready and the person is signed in', () => {
    expect(isTalkReady(READY)).toBe(true);
    expect(isTalkReady(null)).toBe(false);
    expect(isTalkReady({ ...READY, listen: false })).toBe(false);
    expect(isTalkReady({ ...READY, speak: false })).toBe(false);
    expect(isTalkReady({ ...READY, voice: false })).toBe(false);
    expect(isTalkReady({ ...READY, signedIn: false, reason: 'not_signed_in' })).toBe(false);
  });

  test('Talk is not ready away from this Mac', () => {
    expect(isTalkReady({ ...READY, here: false })).toBe(false);
  });
});

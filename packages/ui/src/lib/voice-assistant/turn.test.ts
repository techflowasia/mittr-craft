import { describe, expect, mock, test } from 'bun:test';
import {
  HISTORY_LIMIT,
  TEXT_LIMIT,
  SynthesizeError,
  TranscribeError,
  createVoiceApi,
  isTalkReady,
  type VoiceTurnEvent,
} from './turn';

type FetchCall = [string, RequestInit | undefined];

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

const line = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

function fetchReturning(...responses: Response[]) {
  const calls: FetchCall[] = [];
  const impl = mock(async (input: string, init?: RequestInit) => {
    calls.push([input, init]);
    const next = responses.shift();
    if (!next) throw new Error('no response');
    return next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

async function collect(stream: AsyncIterable<VoiceTurnEvent>) {
  const out: VoiceTurnEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const signal = () => new AbortController().signal;

describe('turn', () => {
  test('posts what was said with the last spoken turns, the locale, directory and session', async () => {
    const fake = fetchReturning(sse([line({ type: 'done' })]));
    const api = createVoiceApi(fake.impl);
    const history = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      text: `turn ${i}`,
    }));
    await collect(api.turn({ said: 'is it done', history, locale: 'th', directory: '/repo', sessionId: 's1' }, signal()));
    const [url, init] = fake.calls[0];
    expect(url).toBe('/api/voice/turn');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body.said).toBe('is it done');
    expect(body.locale).toBe('th');
    expect(body.directory).toBe('/repo');
    expect(body.sessionId).toBe('s1');
    expect(body.history).toHaveLength(HISTORY_LIMIT);
    expect(body.history[0].text).toBe('turn 5');
  });

  test('leaves directory and session out when there are none and clamps long text', async () => {
    const fake = fetchReturning(sse([line({ type: 'done' })]));
    const api = createVoiceApi(fake.impl);
    const long = 'a'.repeat(TEXT_LIMIT + 10);
    await collect(api.turn({ said: long, history: [{ role: 'user', text: long }], locale: 'en' }, signal()));
    const body = JSON.parse(String(fake.calls[0][1]?.body));
    expect('directory' in body).toBe(false);
    expect('sessionId' in body).toBe(false);
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
    const events = await collect(createVoiceApi(fake.impl).turn({ said: 'open chrome', history: [], locale: 'en' }, signal()));
    expect(events).toEqual([
      { type: 'text-delta', text: 'Opening Chrome.' },
      { type: 'action', kind: 'running', label: 'Opening Chrome' },
      { type: 'tool-result', id: 'c1', ok: true },
      { type: 'done' },
    ]);
  });

  test('passes through error codes, including not signed in, and maps unknown ones to upstream_failed', async () => {
    const api = createVoiceApi(
      fetchReturning(
        sse([line({ type: 'error', code: 'not_signed_in' })]),
        sse([line({ type: 'error', code: 'upstream_timeout' })]),
        sse([line({ type: 'error', code: 'weird' })]),
      ).impl,
    );
    const request = { said: 'x', history: [], locale: 'en' as const };
    expect(await collect(api.turn(request, signal()))).toEqual([{ type: 'error', code: 'not_signed_in' }]);
    expect(await collect(api.turn(request, signal()))).toEqual([{ type: 'error', code: 'upstream_timeout' }]);
    expect(await collect(api.turn(request, signal()))).toEqual([{ type: 'error', code: 'upstream_failed' }]);
  });

  test('reads a queue event and sends the queued prompt count when it is known', async () => {
    const fake = fetchReturning(
      sse([line({ type: 'queue', sessionId: 's1', directory: '/repo', text: 'run the tests' }), line({ type: 'done' })]),
      sse([line({ type: 'done' })]),
    );
    const api = createVoiceApi(fake.impl);
    const events = await collect(
      api.turn({ said: 'run the tests', history: [], locale: 'en', sessionId: 's1', directory: '/repo', queuedPrompts: 2 }, signal()),
    );
    expect(events).toEqual([
      { type: 'queue', sessionId: 's1', directory: '/repo', text: 'run the tests' },
      { type: 'done' },
    ]);
    expect(JSON.parse(String(fake.calls[0][1]?.body)).queuedPrompts).toBe(2);
    await collect(api.turn({ said: 'x', history: [], locale: 'en' }, signal()));
    expect('queuedPrompts' in JSON.parse(String(fake.calls[1][1]?.body))).toBe(false);
  });

  test('reads an end event', async () => {
    const fake = fetchReturning(sse([line({ type: 'end' }), line({ type: 'text-delta', text: 'Bye.' }), line({ type: 'done' })]));
    const events = await collect(createVoiceApi(fake.impl).turn({ said: 'bye', history: [], locale: 'en' }, signal()));
    expect(events).toEqual([{ type: 'end' }, { type: 'text-delta', text: 'Bye.' }, { type: 'done' }]);
  });

  test('a refused request yields its error code from the body', async () => {
    const api = createVoiceApi(
      fetchReturning(new Response(JSON.stringify({ code: 'not_signed_in' }), { status: 401 })).impl,
    );
    expect(await collect(api.turn({ said: 'x', history: [], locale: 'en' }, signal()))).toEqual([
      { type: 'error', code: 'not_signed_in' },
    ]);
  });

  test('a stream that ends without done is a failure', async () => {
    const api = createVoiceApi(fetchReturning(sse([line({ type: 'text-delta', text: 'Hi' })])).impl);
    expect(await collect(api.turn({ said: 'x', history: [], locale: 'en' }, signal()))).toEqual([
      { type: 'text-delta', text: 'Hi' },
      { type: 'error', code: 'upstream_failed' },
    ]);
  });
});

describe('synthesize', () => {
  test('asks the mittr provider for one sentence and returns the audio stream', async () => {
    const fake = fetchReturning(new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/wav' } }));
    const audio = await createVoiceApi(fake.impl).synthesize('Hello there.', signal());
    const [url, init] = fake.calls[0];
    expect(url).toBe('/api/tts/speak');
    expect(JSON.parse(String(init?.body))).toEqual({ providerId: 'mittr', text: 'Hello there.' });
    expect(audio.contentType).toBe('audio/wav');
    expect(new Uint8Array(await new Response(audio.body).arrayBuffer())).toEqual(new Uint8Array([1, 2]));
  });

  test('fails on anything that is not audio', async () => {
    const api = createVoiceApi(
      fetchReturning(new Response(JSON.stringify({ error: 'x' }), { status: 401, headers: { 'content-type': 'application/json' } })).impl,
    );
    await expect(api.synthesize('Hi.', signal())).rejects.toThrow();
  });
});

describe('transcribe', () => {
  test('sends the WAV as the audio field and returns the text', async () => {
    const fake = fetchReturning(new Response(JSON.stringify({ text: ' open chrome ' })));
    const text = await createVoiceApi(fake.impl).transcribe(new Blob([new Uint8Array(4)], { type: 'audio/wav' }), signal());
    const [url, init] = fake.calls[0];
    expect(url).toBe('/api/voice/transcribe');
    expect(init?.method).toBe('POST');
    const form = init?.body as FormData;
    expect(form.get('audio')).toBeInstanceOf(Blob);
    expect(text).toBe(' open chrome ');
  });

  test('turns an error reply into a TranscribeError carrying the reason code', async () => {
    const api = createVoiceApi(
      fetchReturning(new Response(JSON.stringify({ error: 'no speech', reasonCode: 'empty_transcript' }), { status: 422 })).impl,
    );
    const failure = await api.transcribe(new Blob([]), signal()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TranscribeError);
    expect((failure as TranscribeError).code).toBe('empty_transcript');
  });
});

describe('weekly quota', () => {
  const RESETS_AT = '2026-10-04T17:00:00.000Z';
  const refusal = () =>
    new Response(JSON.stringify({ error: 'Mittr speech failed', reasonCode: 'llm_quota_exhausted', resetsAt: RESETS_AT }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });

  test('a refused transcription carries the reset time', async () => {
    const failure = await createVoiceApi(fetchReturning(refusal()).impl)
      .transcribe(new Blob([]), signal())
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TranscribeError);
    const { code, resetsAt } = failure as TranscribeError;
    expect({ code, resetsAt }).toEqual({ code: 'llm_quota_exhausted', resetsAt: RESETS_AT });
  });

  test('a refused spoken reply carries the reset time', async () => {
    const failure = await createVoiceApi(fetchReturning(refusal()).impl)
      .synthesize('Hi.', signal())
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SynthesizeError);
    const { code, resetsAt } = failure as SynthesizeError;
    expect({ code, resetsAt }).toEqual({ code: 'llm_quota_exhausted', resetsAt: RESETS_AT });
  });

  test('a refused voice step ends the turn with the quota error', async () => {
    const streamed = await collect(
      createVoiceApi(fetchReturning(sse([line({ type: 'error', code: 'llm_quota_exhausted', resetsAt: RESETS_AT })])).impl).turn(
        { said: 'hi', history: [], locale: 'en' },
        signal(),
      ),
    );
    expect(streamed).toEqual([{ type: 'error', code: 'llm_quota_exhausted', resetsAt: RESETS_AT }]);
    const refused = await collect(
      createVoiceApi(
        fetchReturning(new Response(JSON.stringify({ code: 'llm_quota_exhausted', resetsAt: RESETS_AT }), { status: 429 })).impl,
      ).turn({ said: 'hi', history: [], locale: 'en' }, signal()),
    );
    expect(refused).toEqual([{ type: 'error', code: 'llm_quota_exhausted', resetsAt: RESETS_AT }]);
  });
});

describe('end', () => {
  test('tells the local server the conversation ended, once, with no body', async () => {
    const fake = fetchReturning(new Response(null, { status: 204 }));
    await createVoiceApi(fake.impl).end();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0][0]).toBe('/api/voice/end');
    expect(fake.calls[0][1]?.method).toBe('POST');
    expect(fake.calls[0][1]?.body).toBe(undefined);
  });

  test('never throws when the server cannot be reached', async () => {
    const api = createVoiceApi(async () => {
      throw new Error('offline');
    });
    expect(await api.end()).toBe(undefined);
  });
});

describe('readiness', () => {
  test('reads the local readiness route', async () => {
    const body = { listen: true, speak: true, voice: true, signedIn: true, voiceSilenceMs: 900, reason: null };
    const fake = fetchReturning(new Response(JSON.stringify(body)));
    expect(await createVoiceApi(fake.impl).readiness()).toEqual(body);
    expect(fake.calls[0][0]).toBe('/api/voice/readiness');
  });

  test('a missing voice silence falls back to 900 ms', async () => {
    const body = { listen: true, speak: true, voice: true, signedIn: true, voiceSilenceMs: null, reason: null };
    const ready = await createVoiceApi(fetchReturning(new Response(JSON.stringify(body))).impl).readiness();
    expect(ready?.voiceSilenceMs).toBe(900);
  });

  test('is null when the route fails or answers something else', async () => {
    const api = createVoiceApi(fetchReturning(new Response('nope', { status: 500 }), new Response('{"listen":1}')).impl);
    expect(await api.readiness()).toBeNull();
    expect(await api.readiness()).toBeNull();
  });

  test('talk is ready only when listen, speak and voice are ready and the person is signed in', () => {
    const ready = { listen: true, speak: true, voice: true, signedIn: true, voiceSilenceMs: 900, reason: null };
    expect(isTalkReady(ready)).toBe(true);
    expect(isTalkReady(null)).toBe(false);
    expect(isTalkReady({ ...ready, listen: false })).toBe(false);
    expect(isTalkReady({ ...ready, speak: false })).toBe(false);
    expect(isTalkReady({ ...ready, voice: false })).toBe(false);
    expect(isTalkReady({ ...ready, signedIn: false, reason: 'not_signed_in' })).toBe(false);
  });
});

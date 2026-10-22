import { afterEach, describe, expect, test } from 'bun:test';

import { ListenError, type ConversationListenOptions, type StartConversationListening } from './listen';
import { resetSpokenLanguage, spokenText } from './narration';
import type { AudioPlayer } from './player';
import {
  SynthesizeError,
  TranscribeError,
  type SynthesizeSpeech,
  type SynthesizedAudio,
  type TranscribeSpeech,
  type Transcript,
  type VoiceQueueEvent,
  type VoiceTurnEvent,
  type VoiceTurnRequest,
} from './voiceApi';
import { VoiceSession, type VoiceSessionDeps } from './voiceSession';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function channel() {
  const queue: VoiceTurnEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(event: VoiceTurnEvent) {
      queue.push(event);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *stream(signal: AbortSignal): AsyncGenerator<VoiceTurnEvent> {
      for (;;) {
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        wake = null;
      }
    },
  };
}

function fakePlayer() {
  const played: string[] = [];
  let waiters: (() => void)[] = [];
  let playing = 0;
  const player: AudioPlayer & { stopCalls: number } = {
    stopCalls: 0,
    async play(_type, body) {
      const text = await new Response(body).text();
      played.push(text);
      playing += 1;
    },
    drained() {
      if (!playing) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
    stop() {
      player.stopCalls += 1;
      playing = 0;
      const release = waiters;
      waiters = [];
      release.forEach((fn) => fn());
    },
    get busy() {
      return playing > 0;
    },
  };
  return {
    player,
    played,
    finish() {
      playing = 0;
      const release = waiters;
      waiters = [];
      release.forEach((fn) => fn());
    },
  };
}

const audioOf = (text: string): SynthesizedAudio => {
  const body = new Response(text).body;
  if (!body) throw new Error('no body');
  return { contentType: 'audio/pcm;rate=24000;channels=1', body };
};

type HarnessOptions = Partial<Omit<VoiceSessionDeps, 'transcribe' | 'synthesize'>> & {
  transcribe?: TranscribeSpeech;
  synthesize?: SynthesizeSpeech;
};

function harness(options: HarnessOptions = {}) {
  let mic: ConversationListenOptions | null = null;
  const listened: ConversationListenOptions[] = [];
  const counts = { destroyed: 0, closed: 0, starts: 0, ended: 0 };
  const listen: StartConversationListening = async (listenOptions) => {
    mic = listenOptions;
    listened.push(listenOptions);
    return {
      destroy: () => {
        counts.destroyed += 1;
      },
    };
  };
  const turns: { request: VoiceTurnRequest; signal: AbortSignal }[] = [];
  const channels: ReturnType<typeof channel>[] = [];
  const synthCalls: { text: string; signal: AbortSignal }[] = [];
  const transcribed: { wav: Blob; conversationId: string }[] = [];
  const conversationsEnded: string[] = [];
  let receipts = 0;
  let transcribeImpl: TranscribeSpeech = options.transcribe ?? (async () => ({ text: 'how is it going', heard: `heard_${receipts}` }));
  let synthesizeImpl: SynthesizeSpeech = options.synthesize ?? (async (text) => audioOf(text));
  const audio = fakePlayer();
  const deps: VoiceSessionDeps = {
    listen: options.listen ?? listen,
    startConversation: options.startConversation ?? (async () => {
      counts.starts += 1;
      return `conv_${counts.starts}`;
    }),
    endConversation: (conversationId) => {
      conversationsEnded.push(conversationId);
    },
    transcribe: (wav, conversationId, signal) => {
      receipts += 1;
      transcribed.push({ wav, conversationId });
      return transcribeImpl(wav, conversationId, signal);
    },
    turn: (request, signal) => {
      turns.push({ request, signal });
      const next = channel();
      channels.push(next);
      return next.stream(signal);
    },
    synthesize: (text, signal) => {
      synthCalls.push({ text, signal });
      return synthesizeImpl(text, signal);
    },
    createPlayer: () => ({
      player: audio.player,
      close: () => {
        counts.closed += 1;
      },
    }),
    context: options.context ?? (() => ({})),
    onQueue: options.onQueue ?? (async () => true),
    onEnd: options.onEnd ?? (() => {
      counts.ended += 1;
    }),
    onQuota: options.onQuota,
  };
  const session = new VoiceSession(deps);
  return {
    session,
    mic: () => {
      if (!mic) throw new Error('the microphone never started');
      return mic;
    },
    listened,
    counts,
    turns,
    channels,
    synthCalls,
    transcribed,
    conversationsEnded,
    audio,
    transcribeWith(impl: TranscribeSpeech) {
      transcribeImpl = impl;
    },
    synthesizeWith(impl: SynthesizeSpeech) {
      synthesizeImpl = impl;
    },
  };
}

type Harness = ReturnType<typeof harness>;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function started(h: Harness) {
  await h.session.start({ silenceMs: 900 });
}

const heardAs = (text: string, heard: string): Promise<Transcript> => Promise.resolve({ text, heard });

const sequence = (fallback: string, ...first: Promise<Transcript>[]): TranscribeSpeech => async () => first.shift() ?? { text: fallback, heard: 'heard_fallback' };

const refusing = (code: string, resetsAt: string | null = null): TranscribeSpeech => async () => {
  throw new TranscribeError(code, resetsAt);
};

const line = (value: { role: string; text: string } | undefined) => value && { role: value.role, text: value.text };

async function say(h: Harness) {
  h.mic().onSpeechStart();
  h.mic().onSpeechEnd(new Float32Array([0.1, 0.2]));
  await flush();
}

afterEach(() => resetSpokenLanguage());

describe('VoiceSession turn loop', () => {
  test('listens with the voice silence and sends what was said with the open directory and session', async () => {
    const h = harness({ context: () => ({ directory: '/repo', sessionId: 's1' }) });
    await started(h);
    expect(h.listened[0]?.silenceMs).toBe(900);
    expect(h.session.getSnapshot().phase).toBe('listening');
    await say(h);
    expect(h.transcribed[0]?.wav.type).toBe('audio/wav');
    expect(h.turns[0]?.request).toEqual({
      said: 'how is it going',
      history: [],
      locale: 'en',
      conversationId: 'conv_1',
      heard: 'heard_1',
      directory: '/repo',
      sessionId: 's1',
    });
    expect(h.session.getSnapshot().phase).toBe('thinking');
  });

  test('a turn carries the conversation and the receipt of its own transcription', async () => {
    const h = harness();
    await started(h);
    expect(h.counts.starts).toBe(1);
    await say(h);
    expect(h.transcribed[0]?.conversationId).toBe('conv_1');
    h.channels[0]?.push({ type: 'done' });
    await flush();
    await say(h);
    expect(h.transcribed[1]?.conversationId).toBe('conv_1');
    expect(h.turns.map((turn) => [turn.request.conversationId, turn.request.heard])).toEqual([
      ['conv_1', 'heard_1'],
      ['conv_1', 'heard_2'],
    ]);
  });

  test('the conversation starts before the microphone opens', async () => {
    const order: string[] = [];
    const h = harness({
      startConversation: async () => {
        order.push('start');
        return 'conv_a';
      },
      listen: async () => {
        order.push('listen');
        return { destroy: () => {} };
      },
    });
    await started(h);
    expect(order).toEqual(['start', 'listen']);
  });

  test('a refused start opens no microphone and says Talk is unavailable', async () => {
    const h = harness({
      startConversation: async () => {
        throw new Error('refused');
      },
    });
    await started(h);
    expect(h.listened).toHaveLength(0);
    expect({ phase: h.session.getSnapshot().phase, error: h.session.getSnapshot().error }).toEqual({
      phase: 'idle',
      error: 'mittr.voice.talk.error.unavailable',
    });
  });

  test('speaks each sentence as it arrives, then listens again', async () => {
    const h = harness();
    await started(h);
    await say(h);
    h.channels[0]?.push({ type: 'text-delta', text: 'It is going well. The' });
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual(['It is going well.']);
    expect(h.session.getSnapshot().phase).toBe('speaking');
    h.channels[0]?.push({ type: 'text-delta', text: ' team is on step two' });
    h.channels[0]?.push({ type: 'done' });
    await flush();
    await flush();
    expect(h.audio.played).toEqual(['It is going well.', 'The team is on step two']);
    expect(h.session.getSnapshot().phase).toBe('speaking');
    h.audio.finish();
    await flush();
    expect(h.session.getSnapshot().phase).toBe('listening');
    expect(h.session.getSnapshot().transcript.map((l) => [l.role, l.text])).toEqual([
      ['user', 'how is it going'],
      ['assistant', 'It is going well. The team is on step two'],
    ]);
  });

  test('synthesizes the next sentence while the one before it plays', async () => {
    const h = harness();
    const first = deferred<SynthesizedAudio>();
    let calls = 0;
    h.synthesizeWith(async (text) => {
      calls += 1;
      if (calls === 1) return first.promise;
      return audioOf(text);
    });
    await started(h);
    h.mic().onSpeechEnd(new Float32Array([0.1]));
    await flush();
    h.channels[0]?.push({ type: 'text-delta', text: 'One. Two. Three. ' });
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual(['One.', 'Two.']);
    first.resolve(audioOf('One.'));
    for (let i = 0; i < 20 && h.synthCalls.length < 3; i++) await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual(['One.', 'Two.', 'Three.']);
    expect(h.audio.played).toContain('One.');
    expect(h.audio.player.busy).toBe(true);
  });

  test('carries the last spoken turns as history, at most twenty', async () => {
    const h = harness();
    await started(h);
    for (let round = 0; round < 12; round++) {
      await say(h);
      h.channels[round]?.push({ type: 'text-delta', text: `Answer ${round}.` });
      h.channels[round]?.push({ type: 'done' });
      await flush();
      h.audio.finish();
      await flush();
    }
    await say(h);
    const history = h.turns[12]?.request.history ?? [];
    expect(history).toHaveLength(20);
    expect(history.at(-1)).toEqual({ role: 'assistant', text: 'Answer 11.' });
    expect(history.at(-2)).toEqual({ role: 'user', text: 'how is it going' });
  });

  test('the turn locale follows the language of what was said', async () => {
    const h = harness({ transcribe: async () => ({ text: 'งานเสร็จหรือยัง', heard: 'heard_th' }) });
    await started(h);
    await say(h);
    expect(h.turns[0]?.request.locale).toBe('th');
  });

  test('a running action shows its label until its result arrives', async () => {
    const h = harness();
    await started(h);
    await say(h);
    h.channels[0]?.push({ type: 'action', kind: 'running', label: 'Opening Chrome' });
    await flush();
    expect(h.session.getSnapshot().running).toBe('Opening Chrome');
    h.channels[0]?.push({ type: 'tool-result', id: 'c1', ok: true });
    await flush();
    expect(h.session.getSnapshot().running).toBeNull();
  });

  test('a queue event hands the prompt and its send config to the message queue exactly once and the turn goes on', async () => {
    const queued: VoiceQueueEvent[] = [];
    const sendConfig = { providerID: 'mittr', modelID: 'acme-writer', agent: 'build' };
    const h = harness({
      onQueue: async (event) => {
        queued.push(event);
        return true;
      },
    });
    await started(h);
    await say(h);
    h.channels[0]?.push({ type: 'queue', sessionId: 's1', directory: '/repo', text: 'run the tests', sendConfig });
    h.channels[0]?.push({ type: 'text-delta', text: 'It will run after the current answer.' });
    h.channels[0]?.push({ type: 'done' });
    await flush();
    await flush();
    expect(queued).toEqual([{ sessionId: 's1', directory: '/repo', text: 'run the tests', sendConfig }]);
    expect(h.synthCalls.map((c) => c.text)).toEqual(['It will run after the current answer.']);
    expect(h.session.getSnapshot().error).toBeNull();
  });

  test('a prompt the queue refused is named on the bar', async () => {
    const h = harness({ onQueue: async () => false });
    await started(h);
    await say(h);
    h.channels[0]?.push({ type: 'queue', sessionId: 's1', directory: '/repo', text: 'run the tests', sendConfig: null });
    h.channels[0]?.push({ type: 'done' });
    await flush();
    await flush();
    expect(h.session.getSnapshot().error).toBe('mittr.voice.talk.error.queueFailed');
  });

  test('an end event closes the conversation after the goodbye has played', async () => {
    const h = harness();
    await started(h);
    await say(h);
    h.channels[0]?.push({ type: 'end' });
    h.channels[0]?.push({ type: 'text-delta', text: 'Goodbye.' });
    h.channels[0]?.push({ type: 'done' });
    await flush();
    await flush();
    expect(h.audio.played).toEqual(['Goodbye.']);
    expect(h.session.getSnapshot().phase).toBe('speaking');
    expect(h.counts.ended).toBe(0);
    h.audio.finish();
    await flush();
    expect(h.session.getSnapshot().phase).toBe('idle');
    expect(h.counts.ended).toBe(1);
    expect(h.conversationsEnded).toEqual(['conv_1']);
  });

  test('an end event with nothing to say closes the conversation at once', async () => {
    const h = harness();
    await started(h);
    await say(h);
    h.channels[0]?.push({ type: 'end' });
    h.channels[0]?.push({ type: 'done' });
    await flush();
    await flush();
    expect(h.session.getSnapshot().phase).toBe('idle');
    expect(h.counts.ended).toBe(1);
  });

  test('the queued prompt count and the panel of the open session go with the turn', async () => {
    const h = harness({ context: () => ({ sessionId: 's1', directory: '/repo', queuedPrompts: 3, panelOpen: false }) });
    await started(h);
    await say(h);
    expect(h.turns[0]?.request.queuedPrompts).toBe(3);
    expect(h.turns[0]?.request.panelOpen).toBe(false);
  });

  test('a failed turn says it cannot answer, in the language of what was said', async () => {
    const h = harness({ transcribe: async () => ({ text: 'เปิด Chrome ให้หน่อย', heard: 'heard_th' }) });
    await started(h);
    await say(h);
    h.channels[0]?.push({ type: 'error', code: 'upstream_failed' });
    await flush();
    await flush();
    const sorry = spokenText('unavailable', 'th');
    expect(h.synthCalls.map((c) => c.text)).toEqual([sorry]);
    expect(line(h.session.getSnapshot().transcript.at(-1))).toEqual({ role: 'assistant', text: sorry });
  });

  test('not signed in is spoken and shown on the bar', async () => {
    const h = harness();
    await started(h);
    await say(h);
    h.channels[0]?.push({ type: 'error', code: 'not_signed_in' });
    await flush();
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual([spokenText('notSignedIn', 'en')]);
    expect(h.session.getSnapshot().error).toBe('mittr.voice.talk.error.notSignedIn');
  });

  for (const [code, key] of [
    ['not_configured', 'notConfigured'],
    ['upstream_timeout', 'timeout'],
    ['bad_request', 'unavailable'],
  ] as const) {
    test(`a ${code} turn is spoken as ${key}`, async () => {
      const h = harness();
      await started(h);
      await say(h);
      h.channels[0]?.push({ type: 'error', code });
      await flush();
      await flush();
      expect(h.synthCalls.map((c) => c.text)).toEqual([spokenText(key, 'en')]);
    });
  }

  test('a failed transcription also says it cannot answer', async () => {
    const h = harness({ transcribe: refusing('upstream_failed') });
    await started(h);
    await say(h);
    await flush();
    expect(h.turns).toHaveLength(0);
    expect(h.synthCalls.map((c) => c.text)).toEqual([spokenText('unavailable', 'en')]);
  });

  test('an empty recording is ignored and listening goes on', async () => {
    const h = harness({ transcribe: refusing('empty_transcript') });
    await started(h);
    await say(h);
    expect(h.turns).toHaveLength(0);
    expect(h.synthCalls).toHaveLength(0);
    expect(h.session.getSnapshot().phase).toBe('listening');
  });

  test('an empty transcript is ignored too', async () => {
    const h = harness({ transcribe: async () => ({ text: '  ', heard: 'heard_empty' }) });
    await started(h);
    await say(h);
    expect(h.turns).toHaveLength(0);
    expect(h.session.getSnapshot().phase).toBe('listening');
  });

  for (const [reason, key] of [
    ['mic_denied', 'mittr.voice.talk.error.micDenied'],
    ['no_mic', 'mittr.voice.talk.error.noMic'],
  ] as const) {
    test(`a ${reason} microphone ends the session with ${key}`, async () => {
      const h = harness({
        listen: async () => {
          throw new ListenError(reason);
        },
      });
      await started(h);
      expect({ phase: h.session.getSnapshot().phase, error: h.session.getSnapshot().error }).toEqual({ phase: 'idle', error: key });
      expect(h.counts.closed).toBeGreaterThan(0);
      expect(h.conversationsEnded).toEqual(['conv_1']);
    });
  }
});

describe('VoiceSession barge-in', () => {
  test('speech while the assistant speaks stops playback, drops what is queued and in flight, then sends the new words', async () => {
    const h = harness();
    const hanging = deferred<SynthesizedAudio>();
    let calls = 0;
    h.synthesizeWith(async (text) => {
      calls += 1;
      if (calls === 1) return audioOf(text);
      return hanging.promise;
    });
    await started(h);
    h.mic().onSpeechEnd(new Float32Array([0.1]));
    await flush();
    h.channels[0]?.push({ type: 'text-delta', text: 'First. Second. Third. Fourth. ' });
    await flush();
    await flush();
    expect(h.session.getSnapshot().phase).toBe('speaking');
    const turnSignal = h.turns[0]?.signal;
    expect(h.synthCalls.map((c) => c.text)).toEqual(['First.', 'Second.', 'Third.']);
    const inFlight = h.synthCalls.slice(1).map((c) => c.signal);

    h.mic().onSpeechStart();
    h.mic().onSpeechConfirmed();
    expect(h.audio.player.stopCalls).toBeGreaterThan(0);
    expect(turnSignal?.aborted).toBe(true);
    expect(inFlight.every((signal) => signal.aborted)).toBe(true);
    expect(h.session.getSnapshot().phase).toBe('listening');
    hanging.resolve(audioOf('Second.'));
    await flush();
    await flush();
    expect(h.audio.played).toEqual(['First.']);

    h.transcribeWith(async () => ({ text: 'stop that', heard: 'heard_stop' }));
    h.mic().onSpeechEnd(new Float32Array([0.3]));
    await flush();
    await flush();
    expect(h.synthCalls.map((c) => c.text)).not.toContain('Fourth.');
    expect(h.turns).toHaveLength(2);
    expect(h.turns[1]?.request.said).toBe('stop that');
    expect(h.turns[1]?.request.heard).toBe('heard_stop');
    expect(h.turns[1]?.request.history).toEqual([
      { role: 'user', text: 'how is it going' },
      { role: 'assistant', text: 'First. Second. Third. Fourth.' },
    ]);
  });

  test('speech while it is still thinking cancels that turn too', async () => {
    const h = harness();
    await started(h);
    await say(h);
    const signal = h.turns[0]?.signal;
    h.mic().onSpeechConfirmed();
    expect(signal?.aborted).toBe(true);
  });

  test('a pause mid-sentence while the first half is still being transcribed sends both halves as one turn', async () => {
    const first = deferred<Transcript>();
    const second = deferred<Transcript>();
    const h = harness({
      transcribe: sequence('how is it going', first.promise, second.promise, heardAs('make the deck about the third quarter', 'heard_whole')),
    });
    await started(h);
    h.mic().onSpeechStart();
    h.mic().onSpeechEnd(new Float32Array([0.1]));
    await flush();
    expect(h.session.getSnapshot().phase).toBe('thinking');
    h.mic().onSpeechStart();
    h.mic().onSpeechConfirmed();
    h.mic().onSpeechEnd(new Float32Array([0.2]));
    first.resolve({ text: 'make the deck about', heard: 'heard_first' });
    second.resolve({ text: 'the third quarter', heard: 'heard_second' });
    await flush();
    await flush();
    await flush();
    expect(h.turns).toHaveLength(1);
    expect({ said: h.turns[0]?.request.said, heard: h.turns[0]?.request.heard }).toEqual({
      said: 'make the deck about the third quarter',
      heard: 'heard_whole',
    });
    expect(h.transcribed).toHaveLength(3);
    expect(h.transcribed[2]?.wav.size).toBe(44 + 2 * 2);
    expect(h.session.getSnapshot().transcript.map((l) => [l.role, l.text])).toEqual([['user', 'make the deck about the third quarter']]);
    h.channels[0]?.push({ type: 'text-delta', text: 'On it.' });
    h.channels[0]?.push({ type: 'done' });
    await flush();
    h.audio.finish();
    await flush();
    await say(h);
    expect(h.turns[1]?.request.history).toEqual([
      { role: 'user', text: 'make the deck about the third quarter' },
      { role: 'assistant', text: 'On it.' },
    ]);
  });

  test('a pause after the turn was sent but before any reply resends both halves as one turn', async () => {
    const h = harness({
      transcribe: sequence(
        'how is it going',
        heardAs('make the deck about', 'heard_first'),
        heardAs('the third quarter', 'heard_second'),
        heardAs('make the deck about the third quarter', 'heard_whole'),
      ),
    });
    await started(h);
    await say(h);
    expect(h.turns[0]?.request.said).toBe('make the deck about');
    h.mic().onSpeechStart();
    h.mic().onSpeechConfirmed();
    expect(h.turns[0]?.signal.aborted).toBe(true);
    h.mic().onSpeechEnd(new Float32Array([0.2]));
    await flush();
    await flush();
    await flush();
    expect(h.turns).toHaveLength(2);
    expect({ said: h.turns[1]?.request.said, heard: h.turns[1]?.request.heard, history: h.turns[1]?.request.history }).toEqual({
      said: 'make the deck about the third quarter',
      heard: 'heard_whole',
      history: [],
    });
    expect(h.session.getSnapshot().transcript.map((l) => [l.role, l.text])).toEqual([['user', 'make the deck about the third quarter']]);
  });

  test('if the second half turns out to be a misfire, the first half is still sent with its own receipt', async () => {
    const h = harness({ transcribe: async () => ({ text: 'make the deck about', heard: 'heard_first' }) });
    await started(h);
    await say(h);
    h.mic().onSpeechStart();
    h.mic().onSpeechConfirmed();
    h.mic().onMisfire();
    await flush();
    await flush();
    expect(h.turns).toHaveLength(2);
    expect({ said: h.turns[1]?.request.said, heard: h.turns[1]?.request.heard }).toEqual({ said: 'make the deck about', heard: 'heard_first' });
    expect(h.transcribed).toHaveLength(1);
  });

  test('once the assistant has started replying, new speech is a new turn', async () => {
    const h = harness({
      transcribe: sequence('how is it going', heardAs('make a deck', 'heard_a'), heardAs('actually stop', 'heard_b')),
    });
    await started(h);
    await say(h);
    h.channels[0]?.push({ type: 'text-delta', text: 'Sure' });
    await flush();
    h.mic().onSpeechStart();
    h.mic().onSpeechConfirmed();
    expect(h.turns[0]?.signal.aborted).toBe(true);
    h.mic().onSpeechEnd(new Float32Array([0.2]));
    await flush();
    await flush();
    expect({ said: h.turns[1]?.request.said, heard: h.turns[1]?.request.heard, history: h.turns[1]?.request.history }).toEqual({
      said: 'actually stop',
      heard: 'heard_b',
      history: [
        { role: 'user', text: 'make a deck' },
        { role: 'assistant', text: 'Sure' },
      ],
    });
  });

  test('a cough that misfires does not interrupt', async () => {
    const h = harness();
    await started(h);
    await say(h);
    h.channels[0]?.push({ type: 'text-delta', text: 'Hello there. ' });
    await flush();
    h.mic().onSpeechStart();
    h.mic().onMisfire();
    expect(h.audio.player.stopCalls).toBe(0);
    expect(h.turns[0]?.signal.aborted).toBe(false);
  });
});

describe('VoiceSession narration', () => {
  test('speaks a narration at once while only listening', async () => {
    const h = harness();
    await started(h);
    h.session.narrate('The work is done.');
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual(['The work is done.']);
    expect(line(h.session.getSnapshot().transcript.at(-1))).toEqual({ role: 'assistant', text: 'The work is done.' });
  });

  test('waits while the assistant is thinking or speaking, never cutting in', async () => {
    const h = harness();
    await started(h);
    await say(h);
    h.session.narrate('The work is done.');
    await flush();
    expect(h.synthCalls).toHaveLength(0);
    h.channels[0]?.push({ type: 'text-delta', text: 'Almost there.' });
    h.channels[0]?.push({ type: 'done' });
    await flush();
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual(['Almost there.']);
    h.audio.finish();
    await flush();
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual(['Almost there.', 'The work is done.']);
  });

  test('waits while the person is speaking', async () => {
    const h = harness();
    await started(h);
    h.mic().onSpeechStart();
    h.session.narrate('The work is done.');
    await flush();
    expect(h.synthCalls).toHaveLength(0);
    h.mic().onMisfire();
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual(['The work is done.']);
  });

  test('goes into the history so the assistant knows what it said', async () => {
    const h = harness();
    await started(h);
    h.session.narrate('Shall I run a revision?');
    await flush();
    h.audio.finish();
    await flush();
    await say(h);
    expect(h.turns[0]?.request.history).toEqual([{ role: 'assistant', text: 'Shall I run a revision?' }]);
  });

  test('is ignored when no conversation is open', async () => {
    const h = harness();
    h.session.narrate('The work is done.');
    await flush();
    expect(h.synthCalls).toHaveLength(0);
  });
});

describe('VoiceSession end', () => {
  test('releases the microphone, aborts everything in flight and closes audio', async () => {
    const h = harness();
    await started(h);
    await say(h);
    h.channels[0]?.push({ type: 'text-delta', text: 'Working on' });
    await flush();
    const signal = h.turns[0]?.signal;
    h.session.end();
    expect(h.counts.destroyed).toBe(1);
    expect(signal?.aborted).toBe(true);
    expect(h.audio.player.stopCalls).toBeGreaterThan(0);
    expect(h.counts.closed).toBeGreaterThan(0);
    expect(h.session.getSnapshot().phase).toBe('idle');
    expect(h.session.getSnapshot().transcript).toEqual([]);
    h.mic().onSpeechEnd(new Float32Array([0.1]));
    await flush();
    expect(h.turns).toHaveLength(1);
  });

  test('ending while the microphone is still starting releases it once it arrives', async () => {
    const pending = deferred<{ destroy: () => void }>();
    let destroyed = 0;
    const h = harness({ listen: () => pending.promise });
    const starting = started(h);
    expect(h.session.getSnapshot().phase).toBe('starting');
    await flush();
    h.session.end();
    pending.resolve({
      destroy: () => {
        destroyed += 1;
      },
    });
    await starting;
    expect(destroyed).toBe(1);
    expect(h.session.getSnapshot().phase).toBe('idle');
    expect(h.conversationsEnded).toEqual(['conv_1']);
  });

  test('ending before the server opened the conversation still ends it once it opens', async () => {
    const opening = deferred<string>();
    const h = harness({ startConversation: () => opening.promise });
    const starting = started(h);
    h.session.end();
    opening.resolve('conv_late');
    await starting;
    expect(h.listened).toHaveLength(0);
    expect(h.conversationsEnded).toEqual(['conv_late']);
  });

  test('ending the conversation calls end once with its id', async () => {
    const h = harness();
    h.session.end();
    expect(h.counts.ended).toBe(0);
    await started(h);
    h.session.end();
    h.session.end();
    expect(h.counts.ended).toBe(1);
    expect(h.conversationsEnded).toEqual(['conv_1']);
  });
});

describe('VoiceSession review fixes', () => {
  for (const [code, key] of [
    ['not_signed_in', 'notSignedIn'],
    ['not_configured', 'notConfigured'],
    ['upstream_timeout', 'timeout'],
  ] as const) {
    test(`a transcription refused as ${code} is spoken as ${key}`, async () => {
      const h = harness({ transcribe: refusing(code) });
      await started(h);
      await say(h);
      await flush();
      expect(h.turns).toHaveLength(0);
      expect(h.synthCalls.map((c) => c.text)).toEqual([spokenText(key, 'en')]);
      expect(h.session.getSnapshot().error).toBe(code === 'not_signed_in' ? 'mittr.voice.talk.error.notSignedIn' : null);
    });
  }

  test('a second narration waits while the first is still being synthesized', async () => {
    const h = harness();
    const first = deferred<SynthesizedAudio>();
    let count = 0;
    h.synthesizeWith(async (text) => {
      count += 1;
      if (count === 1) return first.promise;
      return audioOf(text);
    });
    await started(h);
    h.session.narrate('A permission request is waiting on screen.');
    await flush();
    h.session.narrate('The work is done. Want a summary?');
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual(['A permission request is waiting on screen.']);
    expect(h.synthCalls[0]?.signal.aborted).toBe(false);
    expect(h.audio.player.stopCalls).toBe(0);
    first.resolve(audioOf('A permission request is waiting on screen.'));
    await flush();
    h.audio.finish();
    await flush();
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual([
      'A permission request is waiting on screen.',
      'The work is done. Want a summary?',
    ]);
  });

  test('an error narration replaces a done that is still waiting to be spoken', async () => {
    const h = harness();
    await started(h);
    await say(h);
    h.session.narrate(spokenText('done', 'en'), 'done');
    h.session.narrate(spokenText('error', 'en'), 'error');
    h.channels[0]?.push({ type: 'done' });
    await flush();
    await flush();
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual([spokenText('error', 'en')]);
  });

  test('the same queued prompt is queued once per conversation and noted in the history', async () => {
    const queued: VoiceQueueEvent[] = [];
    const h = harness({
      onQueue: async (event) => {
        queued.push(event);
        return true;
      },
    });
    await started(h);
    const event: VoiceTurnEvent = { type: 'queue', sessionId: 's1', directory: '/repo', text: 'run the tests', sendConfig: null };
    await say(h);
    h.channels[0]?.push(event);
    h.mic().onSpeechStart();
    h.mic().onSpeechConfirmed();
    await say(h);
    h.channels[1]?.push(event);
    h.channels[1]?.push({ type: 'done' });
    await flush();
    await flush();
    h.audio.finish();
    await flush();
    await say(h);
    expect(queued).toHaveLength(1);
    const notes = (h.turns[2]?.request.history ?? []).filter((entry) => entry.role === 'assistant' && entry.text.includes('run the tests'));
    expect(notes.length).toBeGreaterThan(0);
  });

  test('only what the person said is ever a user history entry', async () => {
    const h = harness();
    await started(h);
    h.session.narrate('The work is done. Want a summary?');
    await flush();
    h.audio.finish();
    await flush();
    await say(h);
    h.channels[0]?.push({ type: 'error', code: 'upstream_failed' });
    await flush();
    await flush();
    h.audio.finish();
    await flush();
    await say(h);
    const users = (h.turns[1]?.request.history ?? []).filter((entry) => entry.role === 'user').map((entry) => entry.text);
    expect(users).toEqual(['how is it going']);
  });
});

describe('VoiceSession account change', () => {
  test('account_changed ends the conversation silently with the bar line', async () => {
    const h = harness();
    await started(h);
    await say(h);
    h.channels[0]?.push({ type: 'text-delta', text: 'Opening' });
    h.channels[0]?.push({ type: 'error', code: 'account_changed' });
    await flush();
    await flush();
    expect(h.synthCalls).toHaveLength(0);
    expect(h.session.getSnapshot().phase).toBe('idle');
    expect(h.session.getSnapshot().error).toBe('mittr.voice.accountChanged');
    expect(h.counts.destroyed).toBe(1);
    expect(h.conversationsEnded).toEqual(['conv_1']);
  });

  test('a transcription refused for a changed account ends it the same way', async () => {
    const h = harness({ transcribe: refusing('account_changed') });
    await started(h);
    await say(h);
    await flush();
    expect(h.turns).toHaveLength(0);
    expect(h.synthCalls).toHaveLength(0);
    expect(h.session.getSnapshot().error).toBe('mittr.voice.accountChanged');
    expect(h.session.getSnapshot().phase).toBe('idle');
  });
});

describe('VoiceSession conversation refusals', () => {
  test('a turn refused because the conversation ended closes the microphone and ends Talk with the bar line', async () => {
    const h = harness();
    await started(h);
    await say(h);
    h.channels[0]?.push({ type: 'error', code: 'conversation_ended' });
    await flush();
    await flush();
    expect(h.synthCalls).toHaveLength(0);
    expect(h.session.getSnapshot().phase).toBe('idle');
    expect(h.session.getSnapshot().error).toBe('mittr.voice.talk.error.conversationEnded');
    expect(h.counts.destroyed).toBe(1);
    expect(h.counts.closed).toBe(1);
    expect(h.counts.ended).toBe(1);
  });

  test('a transcription refused because the conversation ended does the same and sends no turn', async () => {
    const h = harness({ transcribe: refusing('conversation_ended') });
    await started(h);
    await say(h);
    await flush();
    expect(h.turns).toHaveLength(0);
    expect(h.synthCalls).toHaveLength(0);
    expect(h.session.getSnapshot().phase).toBe('idle');
    expect(h.session.getSnapshot().error).toBe('mittr.voice.talk.error.conversationEnded');
    expect(h.counts.destroyed).toBe(1);
  });

  test('a turn the server did not hear asks to try again and keeps listening', async () => {
    const h = harness();
    await started(h);
    await say(h);
    h.channels[0]?.push({ type: 'error', code: 'not_heard' });
    await flush();
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual([spokenText('timeout', 'en')]);
    expect(h.session.getSnapshot().phase).not.toBe('idle');
    expect(h.session.getSnapshot().error).toBeNull();
    expect(h.counts.destroyed).toBe(0);
  });
});

describe('VoiceSession weekly quota', () => {
  const RESETS_AT = '2026-10-04T17:00:00.000Z';

  test('voice input out of quota ends the conversation, releases the mic and says until when', async () => {
    const quotas: [string, string][] = [];
    const h = harness({
      onQuota: (kind, resetsAt) => {
        quotas.push([kind, resetsAt]);
      },
      transcribe: refusing('llm_quota_exhausted', RESETS_AT),
    });
    await started(h);
    await say(h);
    await flush();
    expect(h.turns).toHaveLength(0);
    expect(h.synthCalls).toHaveLength(0);
    expect(h.counts.destroyed).toBe(1);
    expect(h.counts.ended).toBe(1);
    expect(quotas).toEqual([['stt', RESETS_AT]]);
    expect(h.session.getSnapshot().phase).toBe('idle');
    expect(h.session.getSnapshot().quota).toEqual({ kind: 'stt', resetsAt: RESETS_AT });
  });

  test('spoken replies out of quota show the answer as text and stop asking for speech', async () => {
    const quotas: [string, string][] = [];
    const h = harness({
      onQuota: (kind, resetsAt) => {
        quotas.push([kind, resetsAt]);
      },
      synthesize: async () => {
        throw new SynthesizeError('llm_quota_exhausted', RESETS_AT);
      },
    });
    await started(h);
    await say(h);
    h.channels[0]?.push({ type: 'text-delta', text: 'It is going well. The team is on step two.' });
    h.channels[0]?.push({ type: 'done' });
    await flush();
    await flush();
    await flush();
    expect(h.session.getSnapshot().phase).toBe('listening');
    expect(line(h.session.getSnapshot().transcript.at(-1))).toEqual({ role: 'assistant', text: 'It is going well. The team is on step two.' });
    expect(h.session.getSnapshot().quota).toEqual({ kind: 'tts', resetsAt: RESETS_AT });
    expect(quotas).toEqual([['tts', RESETS_AT]]);
    const asked = h.synthCalls.length;
    await say(h);
    h.channels[1]?.push({ type: 'text-delta', text: 'Still here.' });
    h.channels[1]?.push({ type: 'done' });
    await flush();
    await flush();
    expect(h.synthCalls.length).toBe(asked);
    expect(h.session.getSnapshot().phase).toBe('listening');
    expect(line(h.session.getSnapshot().transcript.at(-1))).toEqual({ role: 'assistant', text: 'Still here.' });
  });

  test('a voice step out of chat quota apologises once and ends the conversation', async () => {
    const h = harness();
    await started(h);
    await say(h);
    h.channels[0]?.push({ type: 'error', code: 'llm_quota_exhausted', resetsAt: RESETS_AT });
    await flush();
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual([spokenText('unavailable', 'en')]);
    h.audio.finish();
    await flush();
    expect(h.session.getSnapshot().phase).toBe('idle');
    expect(h.session.getSnapshot().quota).toEqual({ kind: 'chat', resetsAt: RESETS_AT });
    expect(h.counts.destroyed).toBe(1);
  });

  test('a new conversation starts without the old notice', async () => {
    const h = harness({ transcribe: refusing('llm_quota_exhausted', RESETS_AT) });
    await started(h);
    await say(h);
    await flush();
    await started(h);
    expect(h.session.getSnapshot().quota).toBeNull();
  });
});

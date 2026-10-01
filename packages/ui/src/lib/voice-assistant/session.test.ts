import { afterEach, describe, expect, mock, test } from "bun:test";
import { ListenError } from "./listen";
import { resetSpokenLanguage, spokenText } from "./narration";
import { SynthesizeError, TranscribeError } from "./turn";
import type {
  ConversationListenOptions,
  StartConversationListening,
} from "./listen";
import type { AudioPlayer } from "./player";
import { VoiceSession, type VoiceSessionDeps } from "./session";
import type { VoiceTurnEvent, VoiceTurnRequest } from "./turn";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
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

function harness(overrides: Partial<VoiceSessionDeps> = {}) {
  let mic: ConversationListenOptions | null = null;
  const destroy = mock();
  const listen = mock<StartConversationListening>(async (options) => {
    mic = options;
    return { destroy };
  });
  const turns: { request: VoiceTurnRequest; signal: AbortSignal }[] = [];
  const channels: ReturnType<typeof channel>[] = [];
  const turn = mock((request: VoiceTurnRequest, signal: AbortSignal) => {
    turns.push({ request, signal });
    const next = channel();
    channels.push(next);
    return next.stream(signal);
  });
  const synthCalls: { text: string; signal: AbortSignal }[] = [];
  const synthesize = mock(async (text: string, signal: AbortSignal) => {
    synthCalls.push({ text, signal });
    return {
      contentType: "audio/pcm;rate=24000;channels=1",
      body: new Response(text).body!,
    };
  });
  const audio = fakePlayer();
  const close = mock();
  const deps: VoiceSessionDeps = {
    listen,
    transcribe: mock(async () => "how is it going"),
    turn,
    synthesize,
    createPlayer: () => ({ player: audio.player, close }),
    context: () => ({}),
    onQueue: () => {},
    onEnd: () => {},
    ...overrides,
  };
  const session = new VoiceSession(deps);
  return {
    session,
    deps,
    mic: () => mic!,
    destroy,
    turns,
    channels,
    synthCalls,
    audio,
    close,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function started(h: ReturnType<typeof harness>) {
  await h.session.start({ silenceMs: 900 });
}

type Tracked = { mock: { calls: unknown[][] } };
const calls = (fn: unknown) => (fn as Tracked).mock.calls;
const sequence = (fallback: string, ...first: Promise<string>[]) =>
  mock(async () => (first.length ? first.shift()! : fallback));
const line = (value: { role: string; text: string } | undefined) => value && { role: value.role, text: value.text };

async function say(h: ReturnType<typeof harness>) {
  h.mic().onSpeechStart();
  h.mic().onSpeechEnd(new Float32Array([0.1, 0.2]));
  await flush();
}

afterEach(() => resetSpokenLanguage());

describe("VoiceSession turn loop", () => {
  test("listens with the voice silence and sends what was said with the open directory and session", async () => {
    const h = harness({ context: () => ({ directory: "/repo", sessionId: "s1" }) });
    await started(h);
    expect((calls(h.deps.listen)[0][0] as { silenceMs: number }).silenceMs).toBe(900);
    expect(h.session.getSnapshot().phase).toBe("listening");
    await say(h);
    const wav = calls(h.deps.transcribe)[0][0] as Blob;
    expect(wav.type).toBe("audio/wav");
    expect(h.turns[0].request).toEqual({
      said: "how is it going",
      history: [],
      locale: "en",
      directory: "/repo",
      sessionId: "s1",
    });
    expect(h.session.getSnapshot().phase).toBe("thinking");
  });

  test("speaks each sentence as it arrives, then listens again", async () => {
    const h = harness();
    await started(h);
    await say(h);
    h.channels[0].push({ type: "text-delta", text: "It is going well. The" });
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual(["It is going well."]);
    expect(h.session.getSnapshot().phase).toBe("speaking");
    h.channels[0].push({ type: "text-delta", text: " team is on step two" });
    h.channels[0].push({ type: "done" });
    await flush();
    await flush();
    expect(h.audio.played).toEqual([
      "It is going well.",
      "The team is on step two",
    ]);
    expect(h.session.getSnapshot().phase).toBe("speaking");
    h.audio.finish();
    await flush();
    expect(h.session.getSnapshot().phase).toBe("listening");
    expect(
      h.session.getSnapshot().transcript.map((l) => [l.role, l.text]),
    ).toEqual([
      ["user", "how is it going"],
      ["assistant", "It is going well. The team is on step two"],
    ]);
  });

  test("synthesizes the next sentence while the one before it plays", async () => {
    const h = harness();
    const first = deferred<{
      contentType: string;
      body: ReadableStream<Uint8Array>;
    }>();
    let calls = 0;
    h.deps.synthesize = mock(async (text: string, signal: AbortSignal) => {
      h.synthCalls.push({ text, signal });
      calls += 1;
      if (calls === 1) return first.promise;
      return {
        contentType: "audio/pcm;rate=24000",
        body: new Response(text).body!,
      };
    });
    const session = new VoiceSession(h.deps);
    await session.start({ silenceMs: 900 });
    h.mic().onSpeechEnd(new Float32Array([0.1]));
    await flush();
    h.channels[0].push({ type: "text-delta", text: "One. Two. Three. " });
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual(["One.", "Two."]);
    first.resolve({
      contentType: "audio/pcm;rate=24000",
      body: new Response("One.").body!,
    });
    for (let i = 0; i < 20 && h.synthCalls.length < 3; i++) await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual(["One.", "Two.", "Three."]);
    expect(h.audio.played).toContain("One.");
    expect(h.audio.player.busy).toBe(true);
  });

  test("carries the last spoken turns as history, at most twenty", async () => {
    const h = harness();
    await started(h);
    for (let round = 0; round < 12; round++) {
      await say(h);
      h.channels[round].push({ type: "text-delta", text: `Answer ${round}.` });
      h.channels[round].push({ type: "done" });
      await flush();
      h.audio.finish();
      await flush();
    }
    await say(h);
    const history = h.turns[12].request.history;
    expect(history).toHaveLength(20);
    expect(history.at(-1)).toEqual({ role: "assistant", text: "Answer 11." });
    expect(history.at(-2)).toEqual({ role: "user", text: "how is it going" });
  });

  test("the turn locale follows the language of what was said", async () => {
    const h = harness({ transcribe: mock(async () => "งานเสร็จหรือยัง") });
    await started(h);
    await say(h);
    expect(h.turns[0].request.locale).toBe("th");
  });

  test("a running action shows its label until its result arrives", async () => {
    const h = harness();
    await started(h);
    await say(h);
    h.channels[0].push({ type: "action", kind: "running", label: "Opening Chrome" });
    await flush();
    expect(h.session.getSnapshot().running).toBe("Opening Chrome");
    h.channels[0].push({ type: "tool-result", id: "c1", ok: true });
    await flush();
    expect(h.session.getSnapshot().running).toBeNull();
  });

  test("a queue event hands the prompt to the message queue exactly once and the turn goes on", async () => {
    const queued: unknown[] = [];
    const h = harness({ onQueue: (event) => { queued.push(event); } });
    await started(h);
    await say(h);
    h.channels[0].push({ type: "queue", sessionId: "s1", directory: "/repo", text: "run the tests" });
    h.channels[0].push({ type: "text-delta", text: "It will run after the current answer." });
    h.channels[0].push({ type: "done" });
    await flush();
    await flush();
    expect(queued).toEqual([{ sessionId: "s1", directory: "/repo", text: "run the tests" }]);
    expect(h.synthCalls.map((c) => c.text)).toEqual(["It will run after the current answer."]);
  });

  test("an end event closes the conversation after the goodbye has played", async () => {
    let ended = 0;
    const h = harness({ onEnd: () => { ended += 1; } });
    await started(h);
    await say(h);
    h.channels[0].push({ type: "end" });
    h.channels[0].push({ type: "text-delta", text: "Goodbye." });
    h.channels[0].push({ type: "done" });
    await flush();
    await flush();
    expect(h.audio.played).toEqual(["Goodbye."]);
    expect(h.session.getSnapshot().phase).toBe("speaking");
    expect(ended).toBe(0);
    h.audio.finish();
    await flush();
    expect(h.session.getSnapshot().phase).toBe("idle");
    expect(ended).toBe(1);
  });

  test("an end event with nothing to say closes the conversation at once", async () => {
    let ended = 0;
    const h = harness({ onEnd: () => { ended += 1; } });
    await started(h);
    await say(h);
    h.channels[0].push({ type: "end" });
    h.channels[0].push({ type: "done" });
    await flush();
    await flush();
    expect(h.session.getSnapshot().phase).toBe("idle");
    expect(ended).toBe(1);
  });

  test("the queued prompt count of the open session goes with the turn", async () => {
    const h = harness({ context: () => ({ sessionId: "s1", directory: "/repo", queuedPrompts: 3 }) });
    await started(h);
    await say(h);
    expect(h.turns[0].request.queuedPrompts).toBe(3);
  });

  test("a failed turn says it cannot answer, in the language of what was said", async () => {
    const h = harness({ transcribe: mock(async () => "เปิด Chrome ให้หน่อย") });
    await started(h);
    await say(h);
    h.channels[0].push({ type: "error", code: "upstream_failed" });
    await flush();
    await flush();
    const sorry = spokenText("unavailable", "th");
    expect(h.synthCalls.map((c) => c.text)).toEqual([sorry]);
    expect(line(h.session.getSnapshot().transcript.at(-1))).toEqual({
      role: "assistant",
      text: sorry,
    });
  });

  test("not signed in is spoken and shown on the bar", async () => {
    const h = harness();
    await started(h);
    await say(h);
    h.channels[0].push({ type: "error", code: "not_signed_in" });
    await flush();
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual([spokenText("notSignedIn", "en")]);
    expect(h.session.getSnapshot().error).toBe("voice.talk.error.notSignedIn");
  });

  for (const [code, key] of [
    ["not_configured", "notConfigured"],
    ["upstream_timeout", "timeout"],
    ["bad_request", "unavailable"],
  ] as const) {
    test(`a ${code} turn is spoken as ${key}`, async () => {
      const h = harness();
      await started(h);
      await say(h);
      h.channels[0].push({ type: "error", code });
      await flush();
      await flush();
      expect(h.synthCalls.map((c) => c.text)).toEqual([spokenText(key, "en")]);
    });
  }

  test("a failed transcription also says it cannot answer", async () => {
    const h = harness({
      transcribe: mock(async () => {
        throw new TranscribeError("upstream_failed");
      }),
    });
    await started(h);
    await say(h);
    await flush();
    expect(h.turns).toHaveLength(0);
    expect(h.synthCalls.map((c) => c.text)).toEqual([spokenText("unavailable", "en")]);
  });

  test("an empty recording is ignored and listening goes on", async () => {
    const h = harness({
      transcribe: mock(async () => {
        throw new TranscribeError("empty_transcript");
      }),
    });
    await started(h);
    await say(h);
    expect(h.turns).toHaveLength(0);
    expect(h.synthCalls).toHaveLength(0);
    expect(h.session.getSnapshot().phase).toBe("listening");
  });

  for (const [reason, key] of [
    ["mic_denied", "voice.talk.error.micDenied"],
    ["no_mic", "voice.talk.error.noMic"],
  ] as const) {
    test(`a ${reason} microphone ends the session with ${key}`, async () => {
      const h = harness({
        listen: mock(async () => {
          throw new ListenError(reason);
        }),
      });
      await started(h);
      expect({ phase: h.session.getSnapshot().phase, error: h.session.getSnapshot().error }).toEqual({ phase: "idle", error: key });
      expect(calls(h.close).length).toBeGreaterThan(0);
    });
  }
});

describe("VoiceSession barge-in", () => {
  test("speech while the assistant speaks stops playback, drops what is queued and in flight, then sends the new words", async () => {
    const h = harness();
    const hanging = deferred<{
      contentType: string;
      body: ReadableStream<Uint8Array>;
    }>();
    let calls = 0;
    h.deps.synthesize = mock(async (text: string, signal: AbortSignal) => {
      h.synthCalls.push({ text, signal });
      calls += 1;
      if (calls === 1)
        return {
          contentType: "audio/pcm;rate=24000",
          body: new Response(text).body!,
        };
      return hanging.promise;
    });
    const session = new VoiceSession(h.deps);
    await session.start({ silenceMs: 900 });
    h.mic().onSpeechEnd(new Float32Array([0.1]));
    await flush();
    h.channels[0].push({
      type: "text-delta",
      text: "First. Second. Third. Fourth. ",
    });
    await flush();
    await flush();
    expect(session.getSnapshot().phase).toBe("speaking");
    const turnSignal = h.turns[0].signal;
    expect(h.synthCalls.map((c) => c.text)).toEqual([
      "First.",
      "Second.",
      "Third.",
    ]);
    const inFlight = h.synthCalls.slice(1).map((c) => c.signal);

    h.mic().onSpeechStart();
    h.mic().onSpeechConfirmed();
    expect(h.audio.player.stopCalls).toBeGreaterThan(0);
    expect(turnSignal.aborted).toBe(true);
    expect(inFlight.every((signal) => signal.aborted)).toBe(true);
    expect(session.getSnapshot().phase).toBe("listening");
    hanging.resolve({
      contentType: "audio/pcm;rate=24000",
      body: new Response("Second.").body!,
    });
    await flush();
    await flush();
    expect(h.audio.played).toEqual(["First."]);

    h.deps.transcribe = mock(async () => "stop that");
    h.mic().onSpeechEnd(new Float32Array([0.3]));
    await flush();
    await flush();
    expect(h.synthCalls.map((c) => c.text)).not.toContain("Fourth.");
    expect(h.turns).toHaveLength(2);
    expect(h.turns[1].request.said).toBe("stop that");
    expect(h.turns[1].request.history).toEqual([
      { role: "user", text: "how is it going" },
      { role: "assistant", text: "First. Second. Third. Fourth." },
    ]);
  });

  test("speech while it is still thinking cancels that turn too", async () => {
    const h = harness();
    await started(h);
    await say(h);
    const signal = h.turns[0].signal;
    h.mic().onSpeechConfirmed();
    expect(signal.aborted).toBe(true);
  });

  test("a pause mid-sentence while the first half is still being transcribed sends both halves as one turn", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const h = harness({
      transcribe: sequence("how is it going", first.promise, second.promise),
    });
    await started(h);
    h.mic().onSpeechStart();
    h.mic().onSpeechEnd(new Float32Array([0.1]));
    await flush();
    expect(h.session.getSnapshot().phase).toBe("thinking");
    h.mic().onSpeechStart();
    h.mic().onSpeechConfirmed();
    h.mic().onSpeechEnd(new Float32Array([0.2]));
    first.resolve("make the deck about");
    second.resolve("the third quarter");
    await flush();
    await flush();
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0].request.said).toBe(
      "make the deck about the third quarter",
    );
    expect(
      h.session.getSnapshot().transcript.map((l) => [l.role, l.text]),
    ).toEqual([["user", "make the deck about the third quarter"]]);
    h.channels[0].push({ type: "text-delta", text: "On it." });
    h.channels[0].push({ type: "done" });
    await flush();
    h.audio.finish();
    await flush();
    await say(h);
    expect(h.turns[1].request.history).toEqual([
      { role: "user", text: "make the deck about the third quarter" },
      { role: "assistant", text: "On it." },
    ]);
  });

  test("a pause after the turn was sent but before any reply resends both halves as one turn", async () => {
    const h = harness({
      transcribe: sequence("how is it going", Promise.resolve("make the deck about"), Promise.resolve("the third quarter")),
    });
    await started(h);
    await say(h);
    expect(h.turns[0].request.said).toBe("make the deck about");
    h.mic().onSpeechStart();
    h.mic().onSpeechConfirmed();
    expect(h.turns[0].signal.aborted).toBe(true);
    h.mic().onSpeechEnd(new Float32Array([0.2]));
    await flush();
    await flush();
    expect(h.turns).toHaveLength(2);
    expect({ said: h.turns[1].request.said, history: h.turns[1].request.history }).toEqual({
      said: "make the deck about the third quarter",
      history: [],
    });
    expect(
      h.session.getSnapshot().transcript.map((l) => [l.role, l.text]),
    ).toEqual([["user", "make the deck about the third quarter"]]);
  });

  test("if the second half turns out to be a misfire, the first half is still sent", async () => {
    const h = harness({
      transcribe: mock(async () => "make the deck about"),
    });
    await started(h);
    await say(h);
    h.mic().onSpeechStart();
    h.mic().onSpeechConfirmed();
    h.mic().onMisfire();
    await flush();
    expect(h.turns).toHaveLength(2);
    expect(h.turns[1].request.said).toBe("make the deck about");
    expect(calls(h.deps.transcribe).length).toBe(1);
  });

  test("once the assistant has started replying, new speech is a new turn", async () => {
    const h = harness({
      transcribe: sequence("how is it going", Promise.resolve("make a deck"), Promise.resolve("actually stop")),
    });
    await started(h);
    await say(h);
    h.channels[0].push({ type: "text-delta", text: "Sure" });
    await flush();
    h.mic().onSpeechStart();
    h.mic().onSpeechConfirmed();
    expect(h.turns[0].signal.aborted).toBe(true);
    h.mic().onSpeechEnd(new Float32Array([0.2]));
    await flush();
    await flush();
    expect({ said: h.turns[1].request.said, history: h.turns[1].request.history }).toEqual({
      said: "actually stop",
      history: [
        { role: "user", text: "make a deck" },
        { role: "assistant", text: "Sure" },
      ],
    });
  });

  test("a cough that misfires does not interrupt", async () => {
    const h = harness();
    await started(h);
    await say(h);
    h.channels[0].push({ type: "text-delta", text: "Hello there. " });
    await flush();
    h.mic().onSpeechStart();
    h.mic().onMisfire();
    expect(h.audio.player.stopCalls).toBe(0);
    expect(h.turns[0].signal.aborted).toBe(false);
  });
});

describe("VoiceSession narration", () => {
  test("speaks a narration at once while only listening", async () => {
    const h = harness();
    await started(h);
    h.session.narrate("The work is done.");
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual(["The work is done."]);
    expect(line(h.session.getSnapshot().transcript.at(-1))).toEqual({
      role: "assistant",
      text: "The work is done.",
    });
  });

  test("waits while the assistant is thinking or speaking, never cutting in", async () => {
    const h = harness();
    await started(h);
    await say(h);
    h.session.narrate("The work is done.");
    await flush();
    expect(h.synthCalls).toHaveLength(0);
    h.channels[0].push({ type: "text-delta", text: "Almost there." });
    h.channels[0].push({ type: "done" });
    await flush();
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual(["Almost there."]);
    h.audio.finish();
    await flush();
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual([
      "Almost there.",
      "The work is done.",
    ]);
  });

  test("waits while the person is speaking", async () => {
    const h = harness();
    await started(h);
    h.mic().onSpeechStart();
    h.session.narrate("The work is done.");
    await flush();
    expect(h.synthCalls).toHaveLength(0);
    h.mic().onMisfire();
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual(["The work is done."]);
  });

  test("goes into the history so the assistant knows what it said", async () => {
    const h = harness();
    await started(h);
    h.session.narrate("Shall I run a revision?");
    await flush();
    h.audio.finish();
    await flush();
    await say(h);
    expect(h.turns[0].request.history).toEqual([
      { role: "assistant", text: "Shall I run a revision?" },
    ]);
  });

  test("is ignored when no conversation is open", async () => {
    const h = harness();
    h.session.narrate("The work is done.");
    await flush();
    expect(h.synthCalls).toHaveLength(0);
  });
});

describe("VoiceSession end", () => {
  test("releases the microphone, aborts everything in flight and closes audio", async () => {
    const h = harness();
    await started(h);
    await say(h);
    h.channels[0].push({ type: "text-delta", text: "Working on" });
    await flush();
    const signal = h.turns[0].signal;
    h.session.end();
    expect(calls(h.destroy).length).toBe(1);
    expect(signal.aborted).toBe(true);
    expect(h.audio.player.stopCalls).toBeGreaterThan(0);
    expect(calls(h.close).length).toBeGreaterThan(0);
    expect(h.session.getSnapshot().phase).toBe("idle");
    expect(h.session.getSnapshot().transcript).toEqual([]);
    h.mic().onSpeechEnd(new Float32Array([0.1]));
    await flush();
    expect(h.turns).toHaveLength(1);
  });

  test("ending while the microphone is still starting releases it once it arrives", async () => {
    const pending = deferred<{ destroy: () => void }>();
    const destroy = mock();
    const h = harness({ listen: mock(() => pending.promise) });
    const starting = started(h);
    expect(h.session.getSnapshot().phase).toBe("starting");
    h.session.end();
    pending.resolve({ destroy });
    await starting;
    expect(calls(destroy).length).toBe(1);
    expect(h.session.getSnapshot().phase).toBe("idle");
  });
});

describe("VoiceSession review fixes", () => {
  for (const [code, key] of [
    ["not_signed_in", "notSignedIn"],
    ["not_configured", "notConfigured"],
    ["upstream_timeout", "timeout"],
  ] as const) {
    test(`a transcription refused as ${code} is spoken as ${key}`, async () => {
      const h = harness({
        transcribe: mock(async () => {
          throw new TranscribeError(code);
        }),
      });
      await started(h);
      await say(h);
      await flush();
      expect(h.turns).toHaveLength(0);
      expect(h.synthCalls.map((c) => c.text)).toEqual([spokenText(key, "en")]);
      expect(h.session.getSnapshot().error).toBe(code === "not_signed_in" ? "voice.talk.error.notSignedIn" : null);
    });
  }

  test("a second narration waits while the first is still being synthesized", async () => {
    const h = harness();
    const first = deferred<{ contentType: string; body: ReadableStream<Uint8Array> }>();
    let count = 0;
    h.deps.synthesize = mock(async (text: string, signal: AbortSignal) => {
      h.synthCalls.push({ text, signal });
      count += 1;
      if (count === 1) return first.promise;
      return { contentType: "audio/wav", body: new Response(text).body! };
    });
    const session = new VoiceSession(h.deps);
    await session.start({ silenceMs: 900 });
    session.narrate("A permission request is waiting on screen.");
    await flush();
    session.narrate("The work is done. Want a summary?");
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual(["A permission request is waiting on screen."]);
    expect(h.synthCalls[0].signal.aborted).toBe(false);
    expect(h.audio.player.stopCalls).toBe(0);
    first.resolve({ contentType: "audio/wav", body: new Response("A permission request is waiting on screen.").body! });
    await flush();
    h.audio.finish();
    await flush();
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual([
      "A permission request is waiting on screen.",
      "The work is done. Want a summary?",
    ]);
  });

  test("an error narration replaces a done that is still waiting to be spoken", async () => {
    const h = harness();
    await started(h);
    await say(h);
    h.session.narrate(spokenText("done", "en"), "done");
    h.session.narrate(spokenText("error", "en"), "error");
    h.channels[0].push({ type: "done" });
    await flush();
    await flush();
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual([spokenText("error", "en")]);
  });

  test("the same queued prompt is queued once per conversation and noted in the history", async () => {
    const queued: unknown[] = [];
    const h = harness({ onQueue: (event) => { queued.push(event); } });
    await started(h);
    const event = { type: "queue", sessionId: "s1", directory: "/repo", text: "run the tests" } as const;
    await say(h);
    h.channels[0].push(event);
    h.mic().onSpeechStart();
    h.mic().onSpeechConfirmed();
    await say(h);
    h.channels[1].push(event);
    h.channels[1].push({ type: "done" });
    await flush();
    await flush();
    h.audio.finish();
    await flush();
    await say(h);
    expect(queued).toHaveLength(1);
    const notes = h.turns[2].request.history.filter((entry) => entry.role === "assistant" && entry.text.includes("run the tests"));
    expect(notes.length).toBeGreaterThan(0);
  });

  test("only what the person said is ever a user history entry", async () => {
    const h = harness();
    await started(h);
    h.session.narrate("The work is done. Want a summary?");
    await flush();
    h.audio.finish();
    await flush();
    await say(h);
    h.channels[0].push({ type: "error", code: "upstream_failed" });
    await flush();
    await flush();
    h.audio.finish();
    await flush();
    await say(h);
    const users = h.turns[1].request.history.filter((entry) => entry.role === "user").map((entry) => entry.text);
    expect(users).toEqual(["how is it going"]);
  });

  test("ending the conversation tells the server once", async () => {
    let ended = 0;
    const h = harness({ onEnd: () => { ended += 1; } });
    h.session.end();
    expect(ended).toBe(0);
    await started(h);
    h.session.end();
    h.session.end();
    expect(ended).toBe(1);
  });
});

describe("VoiceSession weekly quota", () => {
  const RESETS_AT = "2026-10-04T17:00:00.000Z";

  test("voice input out of quota ends the conversation, releases the mic and says until when", async () => {
    const onQuota = mock<NonNullable<VoiceSessionDeps["onQuota"]>>(() => {});
    const onEnd = mock();
    const h = harness({
      onQuota,
      onEnd,
      transcribe: mock(async () => {
        throw new TranscribeError("llm_quota_exhausted", RESETS_AT);
      }),
    });
    await started(h);
    await say(h);
    await flush();
    expect(h.turns).toHaveLength(0);
    expect(h.synthCalls).toHaveLength(0);
    expect(calls(h.destroy).length).toBe(1);
    expect(calls(onEnd).length).toBe(1);
    expect(calls(onQuota)).toEqual([["stt", RESETS_AT]]);
    expect(h.session.getSnapshot().phase).toBe("idle");
    expect(h.session.getSnapshot().quota).toEqual({ kind: "stt", resetsAt: RESETS_AT });
  });

  test("spoken replies out of quota show the answer as text and stop asking for speech", async () => {
    const onQuota = mock<NonNullable<VoiceSessionDeps["onQuota"]>>(() => {});
    const synthesize = mock(async () => {
      throw new SynthesizeError("llm_quota_exhausted", RESETS_AT);
    });
    const h = harness({ onQuota, synthesize });
    await started(h);
    await say(h);
    h.channels[0].push({ type: "text-delta", text: "It is going well. The team is on step two." });
    h.channels[0].push({ type: "done" });
    await flush();
    await flush();
    await flush();
    expect(h.session.getSnapshot().phase).toBe("listening");
    expect(line(h.session.getSnapshot().transcript.at(-1))).toEqual({
      role: "assistant",
      text: "It is going well. The team is on step two.",
    });
    expect(h.session.getSnapshot().quota).toEqual({ kind: "tts", resetsAt: RESETS_AT });
    expect(calls(onQuota)).toEqual([["tts", RESETS_AT]]);
    const asked = calls(synthesize).length;
    await say(h);
    h.channels[1].push({ type: "text-delta", text: "Still here." });
    h.channels[1].push({ type: "done" });
    await flush();
    await flush();
    expect(calls(synthesize).length).toBe(asked);
    expect(h.session.getSnapshot().phase).toBe("listening");
    expect(line(h.session.getSnapshot().transcript.at(-1))).toEqual({ role: "assistant", text: "Still here." });
  });

  test("a voice step out of chat quota apologises once and ends the conversation", async () => {
    const h = harness();
    await started(h);
    await say(h);
    h.channels[0].push({ type: "error", code: "llm_quota_exhausted", resetsAt: RESETS_AT });
    await flush();
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual([spokenText("unavailable", "en")]);
    h.audio.finish();
    await flush();
    expect(h.session.getSnapshot().phase).toBe("idle");
    expect(h.session.getSnapshot().quota).toEqual({ kind: "chat", resetsAt: RESETS_AT });
    expect(calls(h.destroy).length).toBe(1);
  });

  test("a new conversation starts without the old notice", async () => {
    const h = harness({
      transcribe: mock(async () => {
        throw new TranscribeError("llm_quota_exhausted", RESETS_AT);
      }),
    });
    await started(h);
    await say(h);
    await flush();
    await started(h);
    expect(h.session.getSnapshot().quota).toBeNull();
  });
});

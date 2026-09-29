import type { I18nKey } from '@/lib/i18n';
import {
  ListenError,
  encodeWav,
  type ConversationListenHandle,
  type StartConversationListening,
} from './listen';
import { noteUtterance, spokenText, type SpokenKey } from './narration';
import type { AudioPlayer } from './player';
import { createSentenceSplitter } from './sentences';
import {
  HISTORY_LIMIT,
  TranscribeError,
  type StreamVoiceTurn,
  type SynthesizeSpeech,
  type TranscribeSpeech,
  type VoiceHistoryEntry,
  type VoiceQueueEvent,
  type VoiceTurnFailure,
} from './turn';

export type VoicePhase = 'idle' | 'starting' | 'listening' | 'thinking' | 'speaking';

export type TranscriptLine = { id: number; role: 'user' | 'assistant'; text: string };

export interface VoiceSnapshot {
  phase: VoicePhase;
  hearing: boolean;
  transcript: readonly TranscriptLine[];
  running: string | null;
  error: I18nKey | null;
}

export interface VoiceTurnContext {
  directory?: string;
  sessionId?: string;
  queuedPrompts?: number;
}

export interface VoiceSessionDeps {
  listen: StartConversationListening;
  transcribe: TranscribeSpeech;
  turn: StreamVoiceTurn;
  synthesize: SynthesizeSpeech;
  createPlayer: () => { player: AudioPlayer; close: () => void };
  context: () => VoiceTurnContext;
  onQueue: (event: VoiceQueueEvent) => void;
  onEnd: () => void;
}

export interface VoiceSessionStart {
  silenceMs: number;
}

const IDLE: VoiceSnapshot = {
  phase: 'idle',
  hearing: false,
  transcript: [],
  running: null,
  error: null,
};

const MIC_MESSAGE: Record<string, I18nKey> = {
  mic_denied: 'voice.talk.error.micDenied',
  no_mic: 'voice.talk.error.noMic',
};

const FAILURE_SPOKEN: Record<VoiceTurnFailure, SpokenKey> = {
  not_signed_in: 'notSignedIn',
  not_configured: 'notConfigured',
  upstream_timeout: 'timeout',
  upstream_failed: 'unavailable',
  bad_request: 'unavailable',
};

type Heard = string | { failure: VoiceTurnFailure };

type Narration = { text: string; tag?: string };

const SUPERSEDES: Record<string, readonly string[]> = { error: ['done'], stopped: ['done'] };

const TRANSCRIBE_FAILURES = new Set<string>(['not_signed_in', 'not_configured', 'upstream_timeout']);

type Exchange = {
  controller: AbortController;
  reply: string;
  recorded: boolean;
  replied: boolean;
  parts: Promise<Heard>[];
  userLine: number | null;
  said: string | null;
};

type Carry = { parts: Promise<Heard>[]; userLine: number | null };

function until(signal: AbortSignal, promise: Promise<unknown>): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done);
    promise.then(done, done);
  });
}

function speakQueue(player: AudioPlayer, synthesize: SynthesizeSpeech, signal: AbortSignal, onPlaying: () => void) {
  type Item = {
    text: string;
    audio?: Promise<Awaited<ReturnType<SynthesizeSpeech>> | null>;
  };
  const items: Item[] = [];
  let current = 0;
  let closed = false;
  let wake: (() => void) | null = null;
  const nudge = () => {
    const fn = wake;
    wake = null;
    fn?.();
  };
  signal.addEventListener('abort', nudge);
  const fetchAudio = (item: Item | undefined) => {
    if (!item || item.audio || signal.aborted) return;
    item.audio = synthesize(item.text, signal).catch(() => null);
  };
  const done = (async () => {
    for (;;) {
      if (signal.aborted) return;
      const item = items[current];
      if (!item) {
        if (closed) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      fetchAudio(item);
      fetchAudio(items[current + 1]);
      const audio = await item.audio;
      if (signal.aborted) return;
      current += 1;
      fetchAudio(items[current]);
      if (!audio) continue;
      onPlaying();
      try {
        await player.play(audio.contentType, audio.body);
      } catch {
        continue;
      }
    }
    await until(signal, player.drained());
  })().finally(() => signal.removeEventListener('abort', nudge));
  return {
    add(text: string) {
      items.push({ text });
      if (items.length - 1 <= current + 1) fetchAudio(items[items.length - 1]);
      nudge();
    },
    close() {
      closed = true;
      nudge();
    },
    done,
  };
}

export class VoiceSession {
  private snapshot: VoiceSnapshot = IDLE;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private mic: ConversationListenHandle | null = null;
  private audio: { player: AudioPlayer; close: () => void } | null = null;
  private exchange: Exchange | null = null;
  private carry: Carry | null = null;
  private lifetime: AbortController | null = null;
  private history: VoiceHistoryEntry[] = [];
  private pending: Narration[] = [];
  private queued = new Set<string>();
  private lineId = 0;

  constructor(private readonly deps: VoiceSessionDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): VoiceSnapshot => this.snapshot;

  async start(options: VoiceSessionStart): Promise<void> {
    if (this.snapshot.phase !== 'idle') return;
    const generation = ++this.generation;
    this.history = [];
    this.pending = [];
    this.queued = new Set();
    this.carry = null;
    this.lifetime?.abort();
    this.lifetime = new AbortController();
    this.set({ ...IDLE, phase: 'starting' });
    this.audio = this.deps.createPlayer();
    const live = () => generation === this.generation;
    let handle: ConversationListenHandle;
    try {
      handle = await this.deps.listen({
        silenceMs: options.silenceMs,
        onSpeechStart: () => {
          if (live()) this.set({ hearing: true });
        },
        onSpeechConfirmed: () => {
          if (!live()) return;
          this.yieldToSpeech();
          this.set({ phase: 'listening', hearing: true, running: null });
        },
        onMisfire: () => {
          if (!live()) return;
          this.set({ hearing: false });
          if (this.carry && !this.exchange) {
            void this.handleUtterance(null);
            return;
          }
          this.flushNarration();
        },
        onSpeechEnd: (samples) => {
          if (!live()) return;
          this.set({ hearing: false });
          void this.handleUtterance(samples);
        },
      });
    } catch (error: unknown) {
      if (!live()) return;
      this.audio?.close();
      this.audio = null;
      this.set({
        ...IDLE,
        error: (error instanceof ListenError && MIC_MESSAGE[error.reason]) || 'voice.talk.error.unavailable',
      });
      return;
    }
    if (!live()) {
      handle.destroy();
      return;
    }
    this.mic = handle;
    this.set({ phase: 'listening' });
    this.flushNarration();
  }

  end(): void {
    if (this.snapshot.phase === 'idle') return;
    this.generation += 1;
    this.interrupt();
    this.carry = null;
    this.lifetime?.abort();
    this.lifetime = null;
    this.mic?.destroy();
    this.mic = null;
    this.audio?.player.stop();
    this.audio?.close();
    this.audio = null;
    this.history = [];
    this.pending = [];
    this.queued = new Set();
    this.set({ ...IDLE });
    this.deps.onEnd();
  }

  narrate(text: string, tag?: string): void {
    if (this.snapshot.phase === 'idle') return;
    const replaced = tag ? SUPERSEDES[tag] : undefined;
    if (replaced) this.pending = this.pending.filter((item) => !item.tag || !replaced.includes(item.tag));
    this.pending.push({ text, tag });
    this.flushNarration();
  }

  private set(patch: Partial<VoiceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private addLine(line: { role: 'user' | 'assistant'; text: string }): number {
    const id = ++this.lineId;
    this.set({ transcript: [...this.snapshot.transcript, { ...line, id }] });
    return id;
  }

  private updateLine(id: number, text: string): void {
    this.set({
      transcript: this.snapshot.transcript.map((line) => (line.id === id ? { ...line, text } : line)),
    });
  }

  private remember(entry: VoiceHistoryEntry): void {
    this.history = [...this.history, entry].slice(-HISTORY_LIMIT);
  }

  private commitSaid(exchange: Exchange): void {
    if (exchange.said === null) return;
    this.remember({ role: 'user', text: exchange.said });
    exchange.said = null;
  }

  private markReplied(exchange: Exchange): void {
    if (exchange.replied) return;
    exchange.replied = true;
    this.commitSaid(exchange);
  }

  private yieldToSpeech(): void {
    const exchange = this.exchange;
    if (exchange && !exchange.replied && exchange.parts.length) {
      this.exchange = null;
      this.carry = { parts: exchange.parts, userLine: exchange.userLine };
      exchange.controller.abort();
      return;
    }
    this.interrupt();
  }

  private interrupt(): void {
    const exchange = this.exchange;
    if (!exchange) return;
    this.exchange = null;
    this.commitSaid(exchange);
    if (!exchange.recorded && exchange.reply.trim()) {
      exchange.recorded = true;
      this.remember({ role: 'assistant', text: exchange.reply.trim() });
    }
    exchange.controller.abort();
    this.audio?.player.stop();
  }

  private begin(): Exchange | null {
    if (!this.audio) return null;
    this.interrupt();
    const exchange: Exchange = {
      controller: new AbortController(),
      reply: '',
      recorded: false,
      replied: false,
      parts: [],
      userLine: null,
      said: null,
    };
    this.exchange = exchange;
    return exchange;
  }

  private finish(exchange: Exchange): void {
    if (this.exchange !== exchange) return;
    this.exchange = null;
    this.set({ phase: 'listening', running: null });
    this.flushNarration();
  }

  private queueFor(exchange: Exchange) {
    return speakQueue(this.audio!.player, this.deps.synthesize, exchange.controller.signal, () => {
      if (this.exchange === exchange && this.snapshot.phase !== 'speaking') this.set({ phase: 'speaking' });
    });
  }

  private flushNarration(): void {
    if (
      !this.pending.length ||
      this.exchange ||
      this.carry ||
      this.snapshot.hearing ||
      this.snapshot.phase !== 'listening'
    )
      return;
    const texts = this.pending.splice(0);
    const exchange = this.begin();
    if (!exchange) return;
    exchange.replied = true;
    const queue = this.queueFor(exchange);
    for (const { text } of texts) {
      this.addLine({ role: 'assistant', text });
      this.remember({ role: 'assistant', text });
      queue.add(text);
    }
    exchange.recorded = true;
    queue.close();
    void queue.done.then(() => {
      if (!exchange.controller.signal.aborted) this.finish(exchange);
    });
  }

  private hear(samples: Float32Array): Promise<Heard> {
    const signal = this.lifetime?.signal;
    return this.deps.transcribe(encodeWav(samples), signal).then(
      (text) => text.trim(),
      (error: unknown): Heard => {
        const code = error instanceof TranscribeError ? error.code : '';
        if (code === 'empty_transcript') return '';
        return { failure: TRANSCRIBE_FAILURES.has(code) ? (code as VoiceTurnFailure) : 'upstream_failed' };
      },
    );
  }

  private async handleUtterance(samples: Float32Array | null): Promise<void> {
    const carried = this.carry;
    this.carry = null;
    const exchange = this.begin();
    if (!exchange) return;
    exchange.parts = [...(carried?.parts ?? []), ...(samples ? [this.hear(samples)] : [])];
    exchange.userLine = carried?.userLine ?? null;
    const { signal } = exchange.controller;
    this.set({ phase: 'thinking' });
    const heard = await Promise.all(exchange.parts);
    if (signal.aborted) return;
    const failed = heard.find((part): part is { failure: VoiceTurnFailure } => typeof part !== 'string');
    if (failed) {
      if (failed.failure === 'not_signed_in') this.set({ error: 'voice.talk.error.notSignedIn' });
      await this.apologise(exchange, FAILURE_SPOKEN[failed.failure]);
      return;
    }
    const said = (heard as string[]).filter(Boolean).join(' ');
    if (!said) {
      this.finish(exchange);
      return;
    }
    const language = noteUtterance(said);
    if (this.snapshot.error) this.set({ error: null });
    if (exchange.userLine === null) exchange.userLine = this.addLine({ role: 'user', text: said });
    else this.updateLine(exchange.userLine, said);
    const history = this.history;
    exchange.said = said;
    const queue = this.queueFor(exchange);
    const splitter = createSentenceSplitter();
    let lineId: number | null = null;
    let failure: VoiceTurnFailure | null = null;
    try {
      for await (const event of this.deps.turn({ said, history, locale: language, ...this.deps.context() }, signal)) {
        if (signal.aborted) return;
        if (event.type !== 'text-delta' || event.text) this.markReplied(exchange);
        if (event.type === 'text-delta') {
          exchange.reply += event.text;
          const shown = exchange.reply.trim();
          if (lineId === null && shown) lineId = this.addLine({ role: 'assistant', text: shown });
          else if (lineId !== null) this.updateLine(lineId, shown);
          for (const sentence of splitter.push(event.text)) queue.add(sentence);
        } else if (event.type === 'action') {
          this.set({ running: event.label });
        } else if (event.type === 'tool-result') {
          this.set({ running: null });
        } else if (event.type === 'queue') {
          const key = `${event.sessionId}\n${event.text}`;
          if (!this.queued.has(key)) {
            this.queued.add(key);
            this.deps.onQueue({ sessionId: event.sessionId, directory: event.directory, text: event.text });
          }
          this.remember({ role: 'assistant', text: `Queued to run after the current answer: ${event.text}` });
        } else if (event.type === 'error') {
          failure = event.code;
          break;
        } else break;
      }
    } catch {
      if (signal.aborted) return;
      failure = 'upstream_failed';
    }
    if (signal.aborted) return;
    this.markReplied(exchange);
    this.set({ running: null });
    for (const sentence of splitter.end()) queue.add(sentence);
    if (exchange.reply.trim()) {
      exchange.recorded = true;
      this.remember({ role: 'assistant', text: exchange.reply.trim() });
    }
    if (failure) {
      if (failure === 'not_signed_in') this.set({ error: 'voice.talk.error.notSignedIn' });
      const sorry = spokenText(FAILURE_SPOKEN[failure], language);
      this.addLine({ role: 'assistant', text: sorry });
      queue.add(sorry);
    }
    queue.close();
    await queue.done;
    if (signal.aborted) return;
    this.finish(exchange);
  }

  private async apologise(exchange: Exchange, key: SpokenKey): Promise<void> {
    this.markReplied(exchange);
    const sorry = spokenText(key);
    this.addLine({ role: 'assistant', text: sorry });
    exchange.recorded = true;
    const queue = this.queueFor(exchange);
    queue.add(sorry);
    queue.close();
    await queue.done;
    if (!exchange.controller.signal.aborted) this.finish(exchange);
  }
}

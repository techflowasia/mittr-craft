import type { MittrKey } from '../strings/mittrT';
import { nextWeeklyReset } from './week';
import {
  ListenError,
  encodeWav,
  type ConversationListenHandle,
  type ListenFailure,
  type StartConversationListening,
} from './listen';
import { noteUtterance, spokenText, type SpokenKey } from './narration';
import type { AudioPlayer } from './player';
import { createSentenceSplitter } from './sentences';
import {
  HISTORY_LIMIT,
  SynthesizeError,
  TranscribeError,
  type StreamVoiceTurn,
  type SynthesizeSpeech,
  type TranscribeSpeech,
  type VoiceHistoryEntry,
  type VoiceQueueEvent,
  type VoiceTurnFailure,
} from './voiceApi';

export type VoicePhase = 'idle' | 'starting' | 'listening' | 'thinking' | 'speaking';

export type TranscriptLine = { id: number; role: 'user' | 'assistant'; text: string };

export type VoiceQuotaNotice = { kind: 'stt' | 'tts' | 'chat'; resetsAt: string };

export interface VoiceSnapshot {
  phase: VoicePhase;
  hearing: boolean;
  transcript: readonly TranscriptLine[];
  running: string | null;
  error: MittrKey | null;
  quota: VoiceQuotaNotice | null;
}

export interface VoiceTurnContext {
  directory?: string;
  sessionId?: string;
  queuedPrompts?: number;
  panelOpen?: boolean;
}

export type VoicePlayback = { player: AudioPlayer; close: () => void };

export interface VoiceSessionDeps {
  listen: StartConversationListening;
  startConversation: () => Promise<string>;
  endConversation: (conversationId: string) => void;
  transcribe: TranscribeSpeech;
  turn: StreamVoiceTurn;
  synthesize: SynthesizeSpeech;
  createPlayer: () => VoicePlayback;
  context: () => VoiceTurnContext;
  onQueue: (event: VoiceQueueEvent) => Promise<boolean>;
  onEnd: () => void;
  onQuota?: (kind: 'stt' | 'tts', resetsAt: string) => void;
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
  quota: null,
};

const MIC_MESSAGE = {
  mic_denied: 'mittr.voice.talk.error.micDenied',
  no_mic: 'mittr.voice.talk.error.noMic',
} satisfies Record<ListenFailure, MittrKey>;

const FAILURE_SPOKEN = {
  not_signed_in: 'notSignedIn',
  not_configured: 'notConfigured',
  upstream_timeout: 'timeout',
  upstream_failed: 'unavailable',
  bad_request: 'unavailable',
  llm_quota_exhausted: 'unavailable',
  account_changed: 'unavailable',
} satisfies Record<VoiceTurnFailure, SpokenKey>;

const QUOTA = 'llm_quota_exhausted';
const ACCOUNT_CHANGED = 'account_changed';

type HeardFailure = { failure: VoiceTurnFailure; resetsAt?: string | null };

type Heard = { text: string; heard: string } | HeardFailure;

type Narration = { text: string; tag?: string };

const SUPERSEDES = new Map<string, readonly string[]>([
  ['error', ['done']],
  ['stopped', ['done']],
]);

type Exchange = {
  controller: AbortController;
  reply: string;
  recorded: boolean;
  replied: boolean;
  parts: Promise<Heard>[];
  samples: Float32Array[];
  userLine: number | null;
  said: string | null;
  closing: boolean;
};

type Carry = { parts: Promise<Heard>[]; samples: Float32Array[]; userLine: number | null };

const isFailure = (part: Heard): part is HeardFailure => 'failure' in part;

function joinSamples(chunks: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function until(signal: AbortSignal, promise: Promise<void>): Promise<void> {
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

type SpeakItem = { text: string; audio?: Promise<Awaited<ReturnType<SynthesizeSpeech>> | null> };

function speakQueue(player: AudioPlayer, synthesize: SynthesizeSpeech, signal: AbortSignal, onPlaying: () => void) {
  const items: SpeakItem[] = [];
  let current = 0;
  let closed = false;
  let wake: (() => void) | null = null;
  const nudge = () => {
    const fn = wake;
    wake = null;
    fn?.();
  };
  signal.addEventListener('abort', nudge);
  const fetchAudio = (item: SpeakItem | undefined) => {
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
  private conversationId: string | null = null;
  private mic: ConversationListenHandle | null = null;
  private audio: VoicePlayback | null = null;
  private exchange: Exchange | null = null;
  private carry: Carry | null = null;
  private lifetime: AbortController | null = null;
  private history: VoiceHistoryEntry[] = [];
  private pending: Narration[] = [];
  private queued = new Set<string>();
  private lineId = 0;
  private speechMuted = false;

  constructor(private readonly deps: VoiceSessionDeps) {}

  private readonly speak: SynthesizeSpeech = (text, signal) => {
    if (this.speechMuted) return Promise.reject(new SynthesizeError(QUOTA));
    return this.deps.synthesize(text, signal).catch((cause: unknown) => {
      if (cause instanceof SynthesizeError && cause.code === QUOTA) this.muteSpeech(cause.resetsAt);
      throw cause;
    });
  };

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
    this.speechMuted = false;
    this.lifetime?.abort();
    this.lifetime = new AbortController();
    this.set({ ...IDLE, phase: 'starting' });
    const live = () => generation === this.generation;
    let conversationId: string;
    try {
      conversationId = await this.deps.startConversation();
    } catch {
      if (live()) this.set({ ...IDLE, error: 'mittr.voice.talk.error.unavailable' });
      return;
    }
    if (!live()) {
      this.deps.endConversation(conversationId);
      return;
    }
    this.conversationId = conversationId;
    this.audio = this.deps.createPlayer();
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
    } catch (cause: unknown) {
      if (!live()) return;
      this.audio?.close();
      this.audio = null;
      this.releaseConversation();
      this.set({
        ...IDLE,
        error: (cause instanceof ListenError && MIC_MESSAGE[cause.reason]) || 'mittr.voice.talk.error.unavailable',
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
    this.speechMuted = false;
    this.releaseConversation();
    this.set({ ...IDLE });
    this.deps.onEnd();
  }

  private releaseConversation(): void {
    const conversationId = this.conversationId;
    this.conversationId = null;
    if (conversationId) this.deps.endConversation(conversationId);
  }

  private muteSpeech(resetsAt: string | null): void {
    if (this.speechMuted) return;
    this.speechMuted = true;
    const blockedUntil = resetsAt ?? nextWeeklyReset(Date.now());
    this.deps.onQuota?.('tts', blockedUntil);
    this.set({ quota: { kind: 'tts', resetsAt: blockedUntil } });
  }

  private closeForQuota(kind: 'stt' | 'chat', resetsAt: string | null | undefined): void {
    const blockedUntil = resetsAt ?? nextWeeklyReset(Date.now());
    if (kind === 'stt') this.deps.onQuota?.('stt', blockedUntil);
    this.end();
    this.set({ quota: { kind, resetsAt: blockedUntil } });
  }

  private closeForAccountChange(): void {
    this.end();
    this.set({ error: 'mittr.voice.accountChanged' });
  }

  narrate(text: string, tag?: string): void {
    if (this.snapshot.phase === 'idle') return;
    const replaced = tag ? SUPERSEDES.get(tag) : undefined;
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
      this.carry = { parts: exchange.parts, samples: exchange.samples, userLine: exchange.userLine };
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
      samples: [],
      userLine: null,
      said: null,
      closing: false,
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
    const audio = this.audio;
    if (!audio) throw new Error('no audio output for this conversation');
    return speakQueue(audio.player, this.speak, exchange.controller.signal, () => {
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
    const conversationId = this.conversationId;
    if (!conversationId) return Promise.resolve({ failure: 'upstream_failed' });
    const signal = this.lifetime?.signal;
    return this.deps.transcribe(encodeWav(samples), conversationId, signal).then(
      (transcript): Heard => ({ text: transcript.text.trim(), heard: transcript.heard }),
      (cause: unknown): Heard => {
        const code = cause instanceof TranscribeError ? cause.code : '';
        if (code === 'empty_transcript') return { text: '', heard: '' };
        if (code === QUOTA && cause instanceof TranscribeError) return { failure: QUOTA, resetsAt: cause.resetsAt };
        if (code === ACCOUNT_CHANGED) return { failure: ACCOUNT_CHANGED };
        if (code === 'not_signed_in' || code === 'not_configured' || code === 'upstream_timeout') return { failure: code };
        return { failure: 'upstream_failed' };
      },
    );
  }

  private async heardWhole(exchange: Exchange): Promise<Heard | null> {
    const heard = await Promise.all(exchange.parts);
    if (exchange.controller.signal.aborted) return null;
    const failed = heard.find(isFailure);
    if (failed) return failed;
    const spoken = heard.filter((part) => !isFailure(part) && part.text);
    if (spoken.length <= 1) return spoken[0] ?? { text: '', heard: '' };
    return this.hear(joinSamples(exchange.samples));
  }

  private async handleUtterance(samples: Float32Array | null): Promise<void> {
    const carried = this.carry;
    this.carry = null;
    const exchange = this.begin();
    if (!exchange) return;
    exchange.parts = [...(carried?.parts ?? []), ...(samples ? [this.hear(samples)] : [])];
    exchange.samples = [...(carried?.samples ?? []), ...(samples ? [samples] : [])];
    exchange.userLine = carried?.userLine ?? null;
    const { signal } = exchange.controller;
    this.set({ phase: 'thinking' });
    const whole = await this.heardWhole(exchange);
    if (signal.aborted || !whole) return;
    if (isFailure(whole)) {
      if (whole.failure === QUOTA) {
        this.closeForQuota('stt', whole.resetsAt);
        return;
      }
      if (whole.failure === ACCOUNT_CHANGED) {
        this.closeForAccountChange();
        return;
      }
      if (whole.failure === 'not_signed_in') this.set({ error: 'mittr.voice.talk.error.notSignedIn' });
      await this.apologise(exchange, FAILURE_SPOKEN[whole.failure]);
      return;
    }
    const said = whole.text;
    const conversationId = this.conversationId;
    if (!said || !conversationId) {
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
    let failureResetsAt: string | null | undefined;
    const generation = this.generation;
    try {
      const request = { said, history, locale: language, conversationId, heard: whole.heard, ...this.deps.context() };
      for await (const event of this.deps.turn(request, signal)) {
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
            const queuedEvent: VoiceQueueEvent = {
              sessionId: event.sessionId,
              directory: event.directory,
              text: event.text,
              sendConfig: event.sendConfig,
            };
            void this.deps.onQueue(queuedEvent).then((queued) => {
              if (!queued && generation === this.generation) this.set({ error: 'mittr.voice.talk.error.queueFailed' });
            });
          }
          this.remember({ role: 'assistant', text: `Queued to run after the current answer: ${event.text}` });
        } else if (event.type === 'end') {
          exchange.closing = true;
        } else if (event.type === 'error') {
          failure = event.code;
          failureResetsAt = event.resetsAt;
          break;
        } else break;
      }
    } catch {
      if (signal.aborted) return;
      failure = 'upstream_failed';
    }
    if (signal.aborted) return;
    if (failure === ACCOUNT_CHANGED) {
      this.closeForAccountChange();
      return;
    }
    this.markReplied(exchange);
    this.set({ running: null });
    for (const sentence of splitter.end()) queue.add(sentence);
    if (exchange.reply.trim()) {
      exchange.recorded = true;
      this.remember({ role: 'assistant', text: exchange.reply.trim() });
    }
    if (failure) {
      if (failure === 'not_signed_in') this.set({ error: 'mittr.voice.talk.error.notSignedIn' });
      const sorry = spokenText(FAILURE_SPOKEN[failure], language);
      this.addLine({ role: 'assistant', text: sorry });
      queue.add(sorry);
    }
    queue.close();
    await queue.done;
    if (signal.aborted) return;
    if (failure === QUOTA) {
      this.closeForQuota('chat', failureResetsAt);
      return;
    }
    if (exchange.closing) {
      this.end();
      return;
    }
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

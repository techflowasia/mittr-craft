import { z } from 'zod';

export const HISTORY_LIMIT = 20;
export const TEXT_LIMIT = 2000;
export const QUEUED_PROMPTS_LIMIT = 1000;
export const DEFAULT_VOICE_SILENCE_MS = 900;

export const VOICE_READINESS_ENDPOINT = '/api/mittr/voice/readiness';
export const VOICE_START_ENDPOINT = '/api/mittr/voice/start';
export const VOICE_END_ENDPOINT = '/api/mittr/voice/end';
export const VOICE_TRANSCRIBE_ENDPOINT = '/api/mittr/voice/transcribe';
export const VOICE_SYNTHESIZE_ENDPOINT = '/api/mittr/voice/synthesize';
export const VOICE_TURN_ENDPOINT = '/api/mittr/voice/turn';
export const VOICE_CONVERSATION_HEADER = 'x-mittr-voice-conversation';

export type SpokenLanguage = 'th' | 'en';

export function clampText(value: string): string {
  if (value.length <= TEXT_LIMIT) return value;
  const cut = value.slice(0, TEXT_LIMIT);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

const FAILURES = [
  'not_signed_in',
  'not_configured',
  'upstream_failed',
  'upstream_timeout',
  'bad_request',
  'llm_quota_exhausted',
  'account_changed',
  'conversation_ended',
  'not_heard',
] as const;

export type VoiceTurnFailure = (typeof FAILURES)[number];

const failureSchema = z.enum(FAILURES).catch('upstream_failed');

const sendConfigSchema = z.object({
  providerID: z.string().min(1),
  modelID: z.string().min(1),
  agent: z.string().min(1).optional(),
  variant: z.string().min(1).optional(),
});

export type QueueSendConfig = z.infer<typeof sendConfigSchema>;

export interface VoiceQueueEvent {
  sessionId: string;
  directory: string;
  text: string;
  sendConfig: QueueSendConfig | null;
}

export type VoiceTurnEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'action'; kind: 'running'; label: string }
  | { type: 'tool-result'; id: string; ok: boolean }
  | ({ type: 'queue' } & VoiceQueueEvent)
  | { type: 'end' }
  | { type: 'done' }
  | { type: 'error'; code: VoiceTurnFailure; resetsAt?: string | null };

export type VoiceHistoryEntry = { role: 'user' | 'assistant'; text: string };

export interface VoiceTurnRequest {
  said: string;
  history: readonly VoiceHistoryEntry[];
  locale: SpokenLanguage;
  conversationId: string;
  heard: string;
  directory?: string;
  sessionId?: string;
  queuedPrompts?: number;
  panelOpen?: boolean;
}

export type StreamVoiceTurn = (request: VoiceTurnRequest, signal: AbortSignal) => AsyncIterable<VoiceTurnEvent>;

export type SynthesizedAudio = { contentType: string; body: ReadableStream<Uint8Array> };

export type SynthesizeSpeech = (text: string, signal: AbortSignal) => Promise<SynthesizedAudio>;

export type Transcript = { text: string; heard: string };

export type TranscribeSpeech = (wav: Blob, conversationId: string, signal?: AbortSignal) => Promise<Transcript>;

const REASONS = ['not_signed_in', 'not_configured', 'unreachable'] as const;

export type VoiceReadinessReason = (typeof REASONS)[number];

export interface VoiceReadiness {
  listen: boolean;
  speak: boolean;
  voice: boolean;
  signedIn: boolean;
  here: boolean;
  voiceSilenceMs: number;
  reason: VoiceReadinessReason | null;
}

export class TranscribeError extends Error {
  constructor(
    readonly code: string,
    readonly resetsAt: string | null = null,
  ) {
    super(code);
    this.name = 'TranscribeError';
  }
}

export class SynthesizeError extends Error {
  constructor(
    readonly code: string,
    readonly resetsAt: string | null = null,
  ) {
    super(code);
    this.name = 'SynthesizeError';
  }
}

export class VoiceStartError extends Error {
  constructor(readonly status: number | null) {
    super('voice_start_failed');
    this.name = 'VoiceStartError';
  }
}

const resetTimeSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)))
  .nullable()
  .catch(null);

const refusalSchema = z.object({
  code: z.string().optional().catch(undefined),
  reasonCode: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
  resetsAt: resetTimeSchema.optional(),
});

const transcriptSchema = z.object({ text: z.string(), heard: z.string().min(1) });

const startSchema = z.object({ conversationId: z.string().min(1) });

const readinessSchema = z.object({
  listen: z.boolean(),
  speak: z.boolean(),
  voice: z.boolean(),
  signedIn: z.boolean(),
  here: z.boolean(),
  voiceSilenceMs: z.number().positive().finite().nullable().optional(),
  reason: z.enum(REASONS).nullable(),
});

const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text-delta'), text: z.string() }),
  z.object({ type: z.literal('action'), kind: z.literal('running'), label: z.string() }),
  z.object({ type: z.literal('tool-result'), id: z.string(), ok: z.boolean() }),
  z.object({
    type: z.literal('queue'),
    sessionId: z.string(),
    directory: z.string(),
    text: z.string(),
    sendConfig: sendConfigSchema.nullable().optional().catch(null),
  }),
  z.object({ type: z.literal('end') }),
  z.object({ type: z.literal('done') }),
  z.object({ type: z.literal('error'), code: failureSchema, resetsAt: resetTimeSchema.optional() }),
]);

type ParsedEvent = z.infer<typeof eventSchema>;

function errorEvent(code: VoiceTurnFailure, resetsAt: string | null | undefined): VoiceTurnEvent {
  return code === 'llm_quota_exhausted' ? { type: 'error', code, resetsAt: resetsAt ?? null } : { type: 'error', code };
}

function toEvent(parsed: ParsedEvent): VoiceTurnEvent {
  if (parsed.type === 'queue') {
    return {
      type: 'queue',
      sessionId: parsed.sessionId,
      directory: parsed.directory,
      text: parsed.text,
      sendConfig: parsed.sendConfig ?? null,
    };
  }
  if (parsed.type === 'error') return errorEvent(parsed.code, parsed.resetsAt);
  return parsed;
}

function readJson(text: string): z.ZodSafeParseResult<ParsedEvent> | null {
  try {
    return eventSchema.safeParse(JSON.parse(text));
  } catch {
    return null;
  }
}

function parse(block: string): VoiceTurnEvent | null {
  const data = block
    .split('\n')
    .filter((row) => row.startsWith('data:'))
    .map((row) => row.slice(5).trim())
    .join('\n');
  if (!data) return null;
  const result = readJson(data);
  return result?.success ? toEvent(result.data) : null;
}

async function readRefusal(res: Response): Promise<z.infer<typeof refusalSchema>> {
  const body = await res.json().catch(() => null);
  const parsed = refusalSchema.safeParse(body);
  return parsed.success ? parsed.data : {};
}

function isAbort(cause: unknown): boolean {
  return (cause instanceof Error || cause instanceof DOMException) && cause.name === 'AbortError';
}

interface TurnBody {
  said: string;
  history: VoiceHistoryEntry[];
  locale: SpokenLanguage;
  conversationId: string;
  heard: string;
  directory?: string;
  sessionId?: string;
  queuedPrompts?: number;
  panelOpen?: boolean;
}

function turnBody(request: VoiceTurnRequest): string {
  const body: TurnBody = {
    said: request.said,
    history: request.history.slice(-HISTORY_LIMIT).map((entry) => ({ role: entry.role, text: clampText(entry.text) })),
    locale: request.locale,
    conversationId: request.conversationId,
    heard: request.heard,
  };
  if (request.directory) body.directory = request.directory;
  if (request.sessionId) body.sessionId = request.sessionId;
  if (request.queuedPrompts !== undefined && Number.isFinite(request.queuedPrompts)) {
    body.queuedPrompts = Math.max(0, Math.min(QUEUED_PROMPTS_LIMIT, Math.floor(request.queuedPrompts)));
  }
  if (request.panelOpen !== undefined) body.panelOpen = request.panelOpen;
  return JSON.stringify(body);
}

export function isTalkReady(readiness: VoiceReadiness | null | undefined): readiness is VoiceReadiness {
  return !!readiness && readiness.here && readiness.listen && readiness.speak && readiness.voice && readiness.signedIn;
}

export interface VoiceApi {
  readiness(): Promise<VoiceReadiness | null>;
  start(): Promise<string>;
  end(conversationId: string): Promise<void>;
  transcribe: TranscribeSpeech;
  synthesize: SynthesizeSpeech;
  turn: StreamVoiceTurn;
}

export type VoiceFetch = (input: string, init?: RequestInit) => Promise<Response>;

export function createVoiceApi(fetchImpl: VoiceFetch): VoiceApi {
  return {
    async readiness() {
      try {
        const res = await fetchImpl(VOICE_READINESS_ENDPOINT, { method: 'GET' });
        if (!res.ok) return null;
        const parsed = readinessSchema.safeParse(await res.json().catch(() => null));
        if (!parsed.success) return null;
        return { ...parsed.data, voiceSilenceMs: parsed.data.voiceSilenceMs ?? DEFAULT_VOICE_SILENCE_MS };
      } catch {
        return null;
      }
    },

    async start() {
      const res = await fetchImpl(VOICE_START_ENDPOINT, { method: 'POST' });
      const parsed = startSchema.safeParse(await res.json().catch(() => null));
      if (!res.ok || !parsed.success) throw new VoiceStartError(res.status);
      return parsed.data.conversationId;
    },

    async end(conversationId) {
      try {
        await fetchImpl(VOICE_END_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ conversationId }),
        });
      } catch {
        return;
      }
    },

    async transcribe(wav, conversationId, signal) {
      const form = new FormData();
      form.append('audio', wav, 'speech.wav');
      const res = await fetchImpl(VOICE_TRANSCRIBE_ENDPOINT, {
        method: 'POST',
        headers: { [VOICE_CONVERSATION_HEADER]: conversationId },
        body: form,
        signal,
      });
      if (res.ok) {
        const parsed = transcriptSchema.safeParse(await res.json().catch(() => null));
        if (parsed.success) return parsed.data;
        throw new TranscribeError('upstream_failed');
      }
      const refusal = await readRefusal(res);
      throw new TranscribeError(refusal.reasonCode ?? 'upstream_failed', refusal.resetsAt ?? null);
    },

    async synthesize(text, signal) {
      const res = await fetchImpl(VOICE_SYNTHESIZE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal,
      });
      const contentType = res.headers.get('content-type') ?? '';
      if (!res.ok && /json/i.test(contentType)) {
        const refusal = await readRefusal(res);
        throw new SynthesizeError(refusal.reasonCode ?? 'synthesize_failed', refusal.resetsAt ?? null);
      }
      if (!res.ok || !res.body || !/^audio\//i.test(contentType)) {
        void res.body?.cancel().catch(() => {});
        throw new SynthesizeError('synthesize_failed');
      }
      return { contentType, body: res.body };
    },

    turn: async function* (request, signal) {
      let res: Response;
      try {
        res = await fetchImpl(VOICE_TURN_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: turnBody(request),
          signal,
        });
      } catch (cause: unknown) {
        if (isAbort(cause)) throw cause;
        yield { type: 'error', code: 'upstream_failed' };
        return;
      }
      if (!res.ok || !res.body) {
        const refusal = await readRefusal(res);
        yield errorEvent(failureSchema.parse(refusal.code ?? refusal.reasonCode ?? refusal.error), refusal.resetsAt);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch (cause: unknown) {
            if (isAbort(cause) || signal.aborted) throw cause;
            yield { type: 'error', code: 'upstream_failed' };
            return;
          }
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          buffer = buffer.replace(/\r\n/g, '\n');
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() ?? '';
          for (const block of blocks) {
            const event = parse(block);
            if (!event) continue;
            yield event;
            if (event.type === 'done' || event.type === 'error') return;
          }
        }
        const last = parse(buffer);
        if (last) {
          yield last;
          if (last.type === 'done' || last.type === 'error') return;
        }
        yield { type: 'error', code: 'upstream_failed' };
      } finally {
        void reader.cancel().catch(() => {});
      }
    },
  };
}

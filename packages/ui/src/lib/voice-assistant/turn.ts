export const HISTORY_LIMIT = 20;
export const TEXT_LIMIT = 2000;

export type SpokenLanguage = 'th' | 'en';

export function clampText(value: string): string {
  if (value.length <= TEXT_LIMIT) return value;
  const cut = value.slice(0, TEXT_LIMIT);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export type VoiceTurnFailure =
  | 'not_signed_in'
  | 'not_configured'
  | 'upstream_failed'
  | 'upstream_timeout'
  | 'bad_request'
  | 'llm_quota_exhausted';

export type VoiceTurnEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'action'; kind: 'running'; label: string }
  | { type: 'tool-result'; id: string; ok: boolean }
  | ({ type: 'queue' } & VoiceQueueEvent)
  | { type: 'end' }
  | { type: 'done' }
  | { type: 'error'; code: VoiceTurnFailure; resetsAt?: string | null };

export interface VoiceQueueEvent {
  sessionId: string;
  directory: string;
  text: string;
}

export type VoiceHistoryEntry = { role: 'user' | 'assistant'; text: string };

export interface VoiceTurnRequest {
  said: string;
  history: readonly VoiceHistoryEntry[];
  locale: SpokenLanguage;
  directory?: string;
  sessionId?: string;
  queuedPrompts?: number;
}

export type StreamVoiceTurn = (request: VoiceTurnRequest, signal: AbortSignal) => AsyncIterable<VoiceTurnEvent>;

export type SynthesizedAudio = { contentType: string; body: ReadableStream<Uint8Array> };

export type SynthesizeSpeech = (text: string, signal: AbortSignal) => Promise<SynthesizedAudio>;

export type TranscribeSpeech = (wav: Blob, signal?: AbortSignal) => Promise<string>;

export interface VoiceReadiness {
  listen: boolean;
  speak: boolean;
  voice: boolean;
  signedIn: boolean;
  voiceSilenceMs: number;
  reason: 'not_signed_in' | 'not_configured' | 'unreachable' | null;
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

const readResetsAt = (value: unknown): string | null =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;

const FAILURES = new Set<VoiceTurnFailure>([
  'not_signed_in',
  'not_configured',
  'upstream_failed',
  'upstream_timeout',
  'bad_request',
  'llm_quota_exhausted',
]);

const REASONS = new Set(['not_signed_in', 'not_configured', 'unreachable']);

function failure(code: unknown): VoiceTurnFailure {
  return typeof code === 'string' && FAILURES.has(code as VoiceTurnFailure)
    ? (code as VoiceTurnFailure)
    : 'upstream_failed';
}

function isAbort(error: unknown): boolean {
  return (error instanceof Error || error instanceof DOMException) && error.name === 'AbortError';
}

function toEvent(raw: unknown): VoiceTurnEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const event = raw as Record<string, unknown>;
  if (event.type === 'text-delta' && typeof event.text === 'string') return { type: 'text-delta', text: event.text };
  if (event.type === 'done') return { type: 'done' };
  if (event.type === 'end') return { type: 'end' };
  if (event.type === 'error') {
    const code = failure(event.code);
    return code === 'llm_quota_exhausted'
      ? { type: 'error', code, resetsAt: readResetsAt(event.resetsAt) }
      : { type: 'error', code };
  }
  if (event.type === 'action' && event.kind === 'running' && typeof event.label === 'string')
    return { type: 'action', kind: 'running', label: event.label };
  if (event.type === 'tool-result' && typeof event.id === 'string' && typeof event.ok === 'boolean')
    return { type: 'tool-result', id: event.id, ok: event.ok };
  if (
    event.type === 'queue' &&
    typeof event.sessionId === 'string' &&
    typeof event.directory === 'string' &&
    typeof event.text === 'string'
  )
    return { type: 'queue', sessionId: event.sessionId, directory: event.directory, text: event.text };
  return null;
}

function parse(block: string): VoiceTurnEvent | null {
  const data = block
    .split('\n')
    .filter((row) => row.startsWith('data:'))
    .map((row) => row.slice(5).trim())
    .join('\n');
  if (!data) return null;
  try {
    return toEvent(JSON.parse(data));
  } catch {
    return null;
  }
}

export const DEFAULT_VOICE_SILENCE_MS = 900;

function isReadiness(value: unknown): value is Omit<VoiceReadiness, 'voiceSilenceMs'> & { voiceSilenceMs: number | null | undefined } {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.listen === 'boolean' &&
    typeof body.speak === 'boolean' &&
    typeof body.voice === 'boolean' &&
    typeof body.signedIn === 'boolean' &&
    (body.voiceSilenceMs === null ||
      body.voiceSilenceMs === undefined ||
      (typeof body.voiceSilenceMs === 'number' && Number.isFinite(body.voiceSilenceMs) && body.voiceSilenceMs > 0)) &&
    (body.reason === null || (typeof body.reason === 'string' && REASONS.has(body.reason)))
  );
}

export function isTalkReady(readiness: VoiceReadiness | null | undefined): readiness is VoiceReadiness {
  return !!readiness && readiness.listen && readiness.speak && readiness.voice && readiness.signedIn;
}

export interface VoiceApi {
  readiness(): Promise<VoiceReadiness | null>;
  end(): Promise<void>;
  transcribe: TranscribeSpeech;
  synthesize: SynthesizeSpeech;
  turn: StreamVoiceTurn;
}

export type VoiceFetch = (input: string, init?: RequestInit) => Promise<Response>;

export function createVoiceApi(fetchImpl: VoiceFetch): VoiceApi {
  const call = (path: string, init?: RequestInit) => fetchImpl(path, init);

  return {
    async readiness() {
      try {
        const res = await call('/api/voice/readiness', { method: 'GET' });
        if (!res.ok) return null;
        const body: unknown = await res.json().catch(() => null);
        if (!isReadiness(body)) return null;
        return { ...body, voiceSilenceMs: body.voiceSilenceMs ?? DEFAULT_VOICE_SILENCE_MS };
      } catch {
        return null;
      }
    },

    async end() {
      try {
        await call('/api/voice/end', { method: 'POST' });
      } catch {
        return;
      }
    },

    async transcribe(wav, signal) {
      const form = new FormData();
      form.append('audio', wav, 'speech.wav');
      const res = await call('/api/voice/transcribe', { method: 'POST', body: form, signal });
      const body = (await res.json().catch(() => null)) as { text?: unknown; reasonCode?: unknown; resetsAt?: unknown } | null;
      if (res.ok && body && typeof body.text === 'string') return body.text;
      throw new TranscribeError(
        typeof body?.reasonCode === 'string' ? body.reasonCode : 'upstream_failed',
        readResetsAt(body?.resetsAt),
      );
    },

    async synthesize(text, signal) {
      const res = await call('/api/tts/speak', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'mittr', text }),
        signal,
      });
      const contentType = res.headers.get('content-type') ?? '';
      if (!res.ok && /json/i.test(contentType)) {
        const body = (await res.json().catch(() => null)) as { reasonCode?: unknown; resetsAt?: unknown } | null;
        throw new SynthesizeError(
          typeof body?.reasonCode === 'string' ? body.reasonCode : 'synthesize_failed',
          readResetsAt(body?.resetsAt),
        );
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
        res = await call('/api/voice/turn', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({
            said: clampText(request.said),
            history: request.history
              .slice(-HISTORY_LIMIT)
              .map((entry) => ({ role: entry.role, text: clampText(entry.text) })),
            locale: request.locale,
            ...(request.directory ? { directory: request.directory } : {}),
            ...(request.sessionId ? { sessionId: request.sessionId } : {}),
            ...(typeof request.queuedPrompts === 'number'
              ? { queuedPrompts: Math.max(0, Math.min(1000, Math.floor(request.queuedPrompts))) }
              : {}),
          }),
          signal,
        });
      } catch (error: unknown) {
        if (isAbort(error)) throw error;
        yield { type: 'error', code: 'upstream_failed' };
        return;
      }
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { code?: unknown; reasonCode?: unknown; resetsAt?: unknown } | null;
        const event = toEvent({ type: 'error', code: body?.code ?? body?.reasonCode, resetsAt: body?.resetsAt });
        yield event ?? { type: 'error', code: 'upstream_failed' };
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
          } catch (error: unknown) {
            if (isAbort(error) || signal.aborted) throw error;
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

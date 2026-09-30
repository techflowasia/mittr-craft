export type QuotaKind = 'chat' | 'image' | 'stt' | 'tts';

export const LLM_QUOTA_EXHAUSTED = 'llm_quota_exhausted';

const INSUFFICIENT_QUOTA = 'insufficient_quota';
const KINDS: ReadonlySet<string> = new Set<QuotaKind>(['chat', 'image', 'stt', 'tts']);

export interface QuotaExhausted {
  kind: QuotaKind;
  resetsAt: string | null;
}

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json | null => {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
};

const readTime = (value: unknown): string | null =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;

export function readQuotaExhausted(value: unknown): QuotaExhausted | null {
  const body = asRecord(value);
  if (!body) return null;

  if (body.code === LLM_QUOTA_EXHAUSTED) {
    const kind = typeof body.kind === 'string' && KINDS.has(body.kind) ? (body.kind as QuotaKind) : 'chat';
    return { kind, resetsAt: readTime(body.resetsAt) };
  }

  const error = asRecord(body.error);
  if (!error) return null;
  const resetsAt = readTime(error.resets_at);
  const named = error.code === LLM_QUOTA_EXHAUSTED || error.reason === LLM_QUOTA_EXHAUSTED;
  const quotaShaped = error.type === INSUFFICIENT_QUOTA || error.code === INSUFFICIENT_QUOTA;
  if (!named && !(quotaShaped && resetsAt)) return null;
  return { kind: 'chat', resetsAt };
}

export function quotaExhaustedFromMessageError(error: unknown): QuotaExhausted | null {
  const info = asRecord(error);
  if (!info) return null;
  const data = asRecord(info.data);
  return (
    readQuotaExhausted(data?.responseBody) ??
    readQuotaExhausted(data?.message) ??
    readQuotaExhausted(info.message)
  );
}

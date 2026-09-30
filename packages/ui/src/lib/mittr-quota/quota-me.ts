import type { QuotaKind } from './exhausted';

export interface QuotaUsageLine {
  modelKey: string;
  kind: QuotaKind;
  label: string;
  used: number;
  limit: number;
}

export interface QuotaMe {
  weekStart: string;
  resetsAt: string;
  lines: QuotaUsageLine[];
}

export type QuotaMeResult =
  | { status: 'ok'; quota: QuotaMe }
  | { status: 'not_signed_in' }
  | { status: 'unreachable' }
  | { status: 'not_available' }
  | { status: 'failed' };

type QuotaFetch = (input: string, init?: RequestInit) => Promise<Response>;

const KINDS: ReadonlySet<string> = new Set<QuotaKind>(['chat', 'image', 'stt', 'tts']);

const isTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

const readLine = (value: unknown): QuotaUsageLine | null => {
  if (!value || typeof value !== 'object') return null;
  const line = value as Record<string, unknown>;
  if (typeof line.modelKey !== 'string' || typeof line.label !== 'string') return null;
  if (typeof line.kind !== 'string' || !KINDS.has(line.kind)) return null;
  if (!isAmount(line.used) || !isAmount(line.limit) || line.limit <= 0) return null;
  return { modelKey: line.modelKey, kind: line.kind as QuotaKind, label: line.label, used: line.used, limit: line.limit };
};

export function parseQuotaMe(value: unknown): QuotaMe | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (!isTime(body.weekStart) || !isTime(body.resetsAt) || !Array.isArray(body.lines)) return null;
  return {
    weekStart: body.weekStart,
    resetsAt: body.resetsAt,
    lines: body.lines.map(readLine).filter((line): line is QuotaUsageLine => line !== null),
  };
}

export async function fetchQuotaMe(fetchImpl: QuotaFetch, signal?: AbortSignal): Promise<QuotaMeResult> {
  let response: Response;
  try {
    response = await fetchImpl('/api/mittr/quota/me', { method: 'GET', signal });
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    return { status: 'unreachable' };
  }
  if (response.status === 401) return { status: 'not_signed_in' };
  if (response.status === 404) return { status: 'not_available' };
  if (response.status === 503 || response.status === 504) return { status: 'unreachable' };
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { reasonCode?: unknown } | null;
    return body?.reasonCode === 'unreachable' ? { status: 'unreachable' } : { status: 'failed' };
  }
  const quota = parseQuotaMe(await response.json().catch(() => null));
  return quota ? { status: 'ok', quota } : { status: 'failed' };
}

export function usedPercent(line: QuotaUsageLine): number {
  return Math.min(100, Math.round((line.used / line.limit) * 100));
}

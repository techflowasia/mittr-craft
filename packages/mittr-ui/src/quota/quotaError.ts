import { z } from 'zod';

import { mittrT } from '../strings/mittrT';
import { formatResetTime, PRODUCT_LOCALE, PRODUCT_TIME_ZONE } from './agentStatus';

const LLM_QUOTA_EXHAUSTED = 'llm_quota_exhausted';
const INSUFFICIENT_QUOTA = 'insufficient_quota';
const NO_ROUTE = 'provider.no-route';
const MITTR_PROVIDER_ID = 'mittr';

type QuotaKind = 'chat' | 'image' | 'stt' | 'tts';

export type QuotaExhausted = { kind: QuotaKind; resetsAt: string | null };

export type MessageError = { type: string; message: string; status?: number; responseBody?: string; providerID?: string };

const resetTime = z.string().refine((value) => !Number.isNaN(Date.parse(value))).nullable().catch(null);
const label = z.string().optional().catch(undefined);

const flatBody = z.object({
  code: z.literal(LLM_QUOTA_EXHAUSTED),
  kind: z.enum(['chat', 'image', 'stt', 'tts']).catch('chat'),
  resetsAt: resetTime,
});

const envelopeBody = z.object({
  error: z.object({
    type: label,
    code: label,
    reason: label,
    message: label,
    resets_at: resetTime,
  }),
});

const parseJson = (text: string | undefined): { ok: true; value: unknown } | { ok: false } => {
  if (!text) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

const readQuotaExhausted = (text: string | undefined): QuotaExhausted | null => {
  const parsed = parseJson(text);
  if (!parsed.ok) return null;

  const flat = flatBody.safeParse(parsed.value);
  if (flat.success) return { kind: flat.data.kind, resetsAt: flat.data.resetsAt };

  const envelope = envelopeBody.safeParse(parsed.value);
  if (!envelope.success) return null;
  const { type, code, reason, message, resets_at: resetsAt } = envelope.data.error;
  const named = code === LLM_QUOTA_EXHAUSTED || reason === LLM_QUOTA_EXHAUSTED;
  const namedInsufficientQuota = type === INSUFFICIENT_QUOTA || code === INSUFFICIENT_QUOTA;
  if (!named && !(namedInsufficientQuota && resetsAt)) return null;
  if (!resetsAt) {
    const inner = readQuotaExhausted(message);
    if (inner?.resetsAt) return inner;
  }
  return { kind: 'chat', resetsAt };
};

export function quotaExhaustedFromError({ message, responseBody }: MessageError): QuotaExhausted | null {
  let found: QuotaExhausted | null = null;
  for (const text of [responseBody, message]) {
    const quota = readQuotaExhausted(text);
    if (quota?.resetsAt) return quota;
    found ??= quota;
  }
  return found;
}

export function mittrMessageError(error: MessageError): string | null {
  const quota = quotaExhaustedFromError(error);
  if (quota) {
    return quota.resetsAt
      ? mittrT('mittr.quota.exhausted.chat', { when: formatResetTime(quota.resetsAt, PRODUCT_LOCALE, PRODUCT_TIME_ZONE) })
      : mittrT('mittr.quota.exhausted.chatNoReset');
  }
  if (error.type === NO_ROUTE) {
    return error.providerID === MITTR_PROVIDER_ID ? mittrT('mittr.providers.noRouteMittr') : mittrT('mittr.providers.noRoute');
  }
  return null;
}

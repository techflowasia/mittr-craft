import { z } from 'zod';

import { mittrT } from '../strings/mittrT';
import { formatResetTime, PRODUCT_LOCALE, PRODUCT_TIME_ZONE } from './agentStatus';
import { MITTR_PROVIDER_ID } from '../mittrProvider';

const LLM_QUOTA_EXHAUSTED = 'llm_quota_exhausted';
const INSUFFICIENT_QUOTA = 'insufficient_quota';
const NO_ROUTE = 'provider.no-route';
const FORBIDDEN = 403;
const STREAM_CUT_OFF = 'stream_cut_off';

const MODEL_REFUSAL_TEXTS = {
  desktop_entitlement_required: 'mittr.model.refused.entitlement',
  agent_not_granted: 'mittr.model.refused.staleCatalog',
} as const;

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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const errorCodesOf = (text: string | undefined): string[] => {
  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) return [];
  const { error } = parsed.value;
  const found = typeof error === 'string' ? [error] : isRecord(error) ? [error.code, error.message] : [];
  return found.filter((candidate): candidate is string => typeof candidate === 'string');
};

const isModelRefusalCode = (code: string): code is keyof typeof MODEL_REFUSAL_TEXTS => Object.hasOwn(MODEL_REFUSAL_TEXTS, code);

const modelRefusalText = ({ status, message, responseBody }: MessageError): string | null => {
  if (status !== FORBIDDEN) return null;
  for (const code of [...errorCodesOf(responseBody), message]) {
    if (isModelRefusalCode(code)) return mittrT(MODEL_REFUSAL_TEXTS[code]);
  }
  return null;
};

const isCutOff = ({ responseBody }: MessageError): boolean => {
  const parsed = parseJson(responseBody);
  return parsed.ok && isRecord(parsed.value) && isRecord(parsed.value.error) && parsed.value.error.code === STREAM_CUT_OFF;
};

export function mittrMessageError(error: MessageError): string | null {
  const quota = quotaExhaustedFromError(error);
  if (quota) {
    return quota.resetsAt
      ? mittrT('mittr.quota.exhausted.chat', { when: formatResetTime(quota.resetsAt, PRODUCT_LOCALE, PRODUCT_TIME_ZONE) })
      : mittrT('mittr.quota.exhausted.chatNoReset');
  }
  const refusal = modelRefusalText(error);
  if (refusal !== null) return refusal;
  if (isCutOff(error)) return mittrT('mittr.answer.cutOff');
  if (error.type === NO_ROUTE) {
    return error.providerID === MITTR_PROVIDER_ID ? mittrT('mittr.providers.noRouteMittr') : mittrT('mittr.providers.noRoute');
  }
  return null;
}

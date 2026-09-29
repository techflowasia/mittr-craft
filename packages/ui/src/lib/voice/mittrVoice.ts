export type VoiceProvider = 'browser' | 'local' | 'openai' | 'openai-compatible' | 'say' | 'mittr';
export type SttProvider = 'local' | 'openai-compatible' | 'mittr';
export type MittrVoiceReason = 'not_signed_in' | 'not_configured' | 'unreachable';

export type MittrVoiceReadiness = {
  listen: boolean;
  speak: boolean;
  voice: boolean;
  signedIn: boolean;
  reason: MittrVoiceReason | null;
};

export const DEFAULT_VOICE_STEP_CAP = 8;
export const VOICE_STEP_CAP_MIN = 1;
export const VOICE_STEP_CAP_MAX = 20;
export const DEFAULT_VOICE_REPLY_MAX_CHARS = 8000;
export const VOICE_REPLY_MAX_CHARS_MIN = 1000;
export const VOICE_REPLY_MAX_CHARS_MAX = 30000;

const VOICE_PROVIDERS: readonly VoiceProvider[] = ['browser', 'local', 'openai', 'openai-compatible', 'say', 'mittr'];
const MITTR_VOICE_REASONS: readonly MittrVoiceReason[] = ['not_signed_in', 'not_configured', 'unreachable'];

const isVoiceProvider = (value: unknown): value is VoiceProvider =>
  typeof value === 'string' && (VOICE_PROVIDERS as readonly string[]).includes(value);

export const normalizeSttProvider = (value: unknown): SttProvider | undefined => {
  if (value === 'local' || value === 'openai-compatible' || value === 'mittr') {
    return value;
  }
  if (value === 'server') {
    return 'openai-compatible';
  }
  if (value === 'browser' || value === 'wasm') {
    return 'local';
  }
  return undefined;
};

export const resolveInitialVoiceProvider = (saved: string | null): VoiceProvider => {
  if (saved === null) return 'mittr';
  return isVoiceProvider(saved) ? saved : 'browser';
};

export const resolveInitialSttProvider = (saved: string | null): SttProvider => {
  if (saved === null) return 'mittr';
  return normalizeSttProvider(saved) ?? 'local';
};

const clampInteger = (value: number, min: number, max: number, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
};

export const clampVoiceStepCap = (value: number): number =>
  clampInteger(value, VOICE_STEP_CAP_MIN, VOICE_STEP_CAP_MAX, DEFAULT_VOICE_STEP_CAP);

export const clampVoiceReplyMaxChars = (value: number): number =>
  clampInteger(value, VOICE_REPLY_MAX_CHARS_MIN, VOICE_REPLY_MAX_CHARS_MAX, DEFAULT_VOICE_REPLY_MAX_CHARS);

export const parseMittrVoiceReadiness = (payload: unknown): MittrVoiceReadiness | null => {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const reason = MITTR_VOICE_REASONS.find((candidate) => candidate === record.reason) ?? null;
  return {
    listen: record.listen === true,
    speak: record.speak === true,
    voice: record.voice === true,
    signedIn: record.signedIn === true,
    reason,
  };
};

export const mittrReasonFor = (
  readiness: MittrVoiceReadiness | null,
  part: 'listen' | 'speak',
): MittrVoiceReason | null => {
  if (!readiness || readiness[part]) return null;
  return readiness.reason ?? 'not_configured';
};

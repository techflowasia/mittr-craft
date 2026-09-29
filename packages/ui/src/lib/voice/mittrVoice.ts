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

type InstallFacts = {
  vscode: boolean;
  localModelSaved?: boolean;
  localModelInstalled?: boolean;
};

export const resolveUnsavedSttProvider = ({ vscode, localModelSaved, localModelInstalled }: InstallFacts): SttProvider =>
  vscode || localModelSaved || localModelInstalled ? 'local' : 'mittr';

export const resolveInitialVoiceProvider = (saved: string | null, { vscode }: InstallFacts): VoiceProvider => {
  if (saved === null) return vscode ? 'browser' : 'mittr';
  return isVoiceProvider(saved) ? saved : 'browser';
};

export const resolveInitialSttProvider = (saved: string | null, facts: InstallFacts): SttProvider => {
  if (saved === null) return resolveUnsavedSttProvider(facts);
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

export const MITTR_SPEECH_CHUNK_CHARS = 600;

const splitLongPiece = (piece: string, maxChars: number): string[] => {
  const out: string[] = [];
  let current = '';
  for (const word of piece.split(/(\s+)/)) {
    if (current.length + word.length <= maxChars) {
      current += word;
      continue;
    }
    if (current.trim()) out.push(current.trim());
    current = '';
    const codePoints = Array.from(word);
    while (codePoints.length > maxChars) {
      out.push(codePoints.splice(0, maxChars).join(''));
    }
    current = codePoints.join('');
  }
  if (current.trim()) out.push(current.trim());
  return out;
};

export const splitForMittrSpeech = (text: string, maxChars = MITTR_SPEECH_CHUNK_CHARS): string[] => {
  const sentences = text
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .flatMap((sentence) => (sentence.length > maxChars ? splitLongPiece(sentence, maxChars) : [sentence]));
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (!current) {
      current = sentence;
    } else if (current.length + 1 + sentence.length <= maxChars) {
      current = `${current} ${sentence}`;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
};

type SpeakWithMittrOptions = {
  text: string;
  readSpeakReadiness: () => Promise<MittrVoiceReadiness | null>;
  speakChunk: (chunk: string) => Promise<void>;
  isCancelled: () => boolean;
};

export type SpeakWithMittrResult =
  | { status: 'spoken' }
  | { status: 'cancelled' }
  | { status: 'unavailable'; reason: MittrVoiceReason };

export const speakWithMittr = async ({
  text,
  readSpeakReadiness,
  speakChunk,
  isCancelled,
}: SpeakWithMittrOptions): Promise<SpeakWithMittrResult> => {
  const readiness = await readSpeakReadiness();
  if (isCancelled()) return { status: 'cancelled' };
  if (!readiness?.speak) {
    return { status: 'unavailable', reason: readiness?.reason ?? 'unreachable' };
  }
  for (const chunk of splitForMittrSpeech(text)) {
    if (isCancelled()) return { status: 'cancelled' };
    await speakChunk(chunk);
  }
  return isCancelled() ? { status: 'cancelled' } : { status: 'spoken' };
};

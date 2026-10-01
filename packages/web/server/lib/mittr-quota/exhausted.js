export const LLM_QUOTA_EXHAUSTED = 'llm_quota_exhausted';
export const QUOTA_REFUSAL_STATUS = 402;

const INSUFFICIENT_QUOTA = 'insufficient_quota';
const KINDS = new Set(['chat', 'image', 'stt', 'tts']);

const parseMaybeJson = (value) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const readTime = (value) => {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return value;
};

export const readQuotaExhausted = (value) => {
  const body = parseMaybeJson(value);
  if (!body || typeof body !== 'object') return null;

  if (body.code === LLM_QUOTA_EXHAUSTED) {
    return { kind: KINDS.has(body.kind) ? body.kind : 'chat', resetsAt: readTime(body.resetsAt) };
  }

  const error = body.error;
  if (!error || typeof error !== 'object') return null;
  const resetsAt = readTime(error.resets_at);
  const named = error.code === LLM_QUOTA_EXHAUSTED || error.reason === LLM_QUOTA_EXHAUSTED;
  const quotaShaped = error.type === INSUFFICIENT_QUOTA || error.code === INSUFFICIENT_QUOTA;
  if (!named && !(quotaShaped && resetsAt)) return null;
  return { kind: 'chat', resetsAt };
};

const ENGINE_MESSAGE = 'Weekly model quota used up';

const toWholeSeconds = (resetsAt) => (
  resetsAt ? new Date(Math.floor(Date.parse(resetsAt) / 1000) * 1000).toISOString() : null
);

export const toEngineRefusal = (quota) => ({
  error: {
    type: INSUFFICIENT_QUOTA,
    code: LLM_QUOTA_EXHAUSTED,
    message: ENGINE_MESSAGE,
    kind: quota.kind,
    resets_at: toWholeSeconds(quota.resetsAt),
  },
});

const toStreamRefusal = (quota) => ({
  error: {
    type: INSUFFICIENT_QUOTA,
    code: LLM_QUOTA_EXHAUSTED,
    message: JSON.stringify({
      type: 'error',
      error: {
        type: INSUFFICIENT_QUOTA,
        code: INSUFFICIENT_QUOTA,
        reason: LLM_QUOTA_EXHAUSTED,
        kind: quota.kind,
        resets_at: toWholeSeconds(quota.resetsAt),
      },
    }),
  },
});

const rewriteLine = (line) => {
  if (!line.startsWith('data:') || !line.includes(LLM_QUOTA_EXHAUSTED)) return line;
  const quota = readQuotaExhausted(line.slice('data:'.length).trim());
  if (!quota) return line;
  return `data: ${JSON.stringify(toStreamRefusal(quota))}`;
};

export const createQuotaStreamRewriter = () => {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let tail = '';

  const push = (chunk) => {
    const text = tail + decoder.decode(chunk, { stream: true });
    const cut = text.lastIndexOf('\n');
    if (cut === -1) {
      tail = text;
      return new Uint8Array(0);
    }
    tail = text.slice(cut + 1);
    const complete = text.slice(0, cut + 1);
    if (!complete.includes(LLM_QUOTA_EXHAUSTED)) return encoder.encode(complete);
    return encoder.encode(complete.split('\n').map(rewriteLine).join('\n'));
  };

  const end = () => {
    const rest = tail + decoder.decode();
    tail = '';
    return encoder.encode(rewriteLine(rest));
  };

  return { push, end };
};

export const quotaFieldsOf = (error) => (
  error?.reasonCode === LLM_QUOTA_EXHAUSTED ? { resetsAt: error.resetsAt ?? null } : {}
);

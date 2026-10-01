const REASONS = new Set(['quota', 'failed', 'silent']);
const ANSWERS_PER_SESSION = 10;
const SESSIONS_KEPT = 100;

const isLabel = (value) => typeof value === 'string' && value.trim().length > 0;

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export const readAnsweredBy = (input) => {
  const value = typeof input === 'string' ? parseJson(input) : input;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const answeredBy = value.answered_by;
  if (!answeredBy || typeof answeredBy !== 'object' || answeredBy.substituted !== true) return null;
  const { requestedLabel, answeredLabel, reason } = answeredBy;
  if (!isLabel(requestedLabel) || !isLabel(answeredLabel) || !REASONS.has(reason)) return null;
  return { requestedLabel: requestedLabel.trim(), answeredLabel: answeredLabel.trim(), reason };
};

export const sessionIdOf = (headers) => {
  const value = headers?.['x-session-id'] ?? headers?.['x-session-affinity'];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const readChunk = (line) => {
  if (!line.startsWith('data:')) return null;
  const value = parseJson(line.slice('data:'.length).trim());
  return value && typeof value === 'object' && Array.isArray(value.choices) ? value : null;
};

export const createAnsweredByWatcher = (onAnsweredBy) => {
  const decoder = new TextDecoder();
  let tail = '';
  let settled = false;

  const settle = (chunk) => {
    settled = true;
    tail = '';
    const answeredBy = readAnsweredBy(chunk);
    if (answeredBy) onAnsweredBy(answeredBy);
  };

  const scan = (text) => {
    const lines = text.split('\n');
    tail = lines.pop() ?? '';
    for (const line of lines) {
      const chunk = readChunk(line.trimEnd());
      if (chunk) {
        settle(chunk);
        return;
      }
    }
  };

  return {
    observe: (bytes) => {
      if (settled) return;
      scan(tail + decoder.decode(bytes, { stream: true }));
    },
    finish: () => {
      if (settled) return;
      const chunk = readChunk((tail + decoder.decode()).trimEnd());
      if (chunk) settle(chunk);
      settled = true;
    },
  };
};

export const createAnsweredByLog = ({ perSession = ANSWERS_PER_SESSION, sessions = SESSIONS_KEPT } = {}) => {
  const bySession = new Map();

  const record = (sessionId, answer) => {
    const answers = bySession.get(sessionId) ?? [];
    bySession.delete(sessionId);
    bySession.set(sessionId, [...answers, answer].slice(-perSession));
    while (bySession.size > sessions) {
      bySession.delete(bySession.keys().next().value);
    }
  };

  const list = (sessionId) => bySession.get(sessionId) ?? [];

  return { record, list };
};

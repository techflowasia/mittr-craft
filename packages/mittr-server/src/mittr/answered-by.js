const REASONS = new Set(['quota', 'failed', 'silent']);
const ANSWERS_PER_SESSION = 10;
const SESSIONS_KEPT = 100;
const REQUESTS_WATCHED = 200;
const BODY_LIMIT = 1 << 20;

const isLabel = (value) => typeof value === 'string' && value.trim().length > 0;

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export const readAnsweredBy = (textOrObj) => {
  const value = typeof textOrObj === 'string' ? parseJson(textOrObj) : textOrObj;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const answeredBy = value.answered_by;
  if (!answeredBy || typeof answeredBy !== 'object' || answeredBy.substituted !== true) return null;
  const { requestedLabel, answeredLabel, reason } = answeredBy;
  if (!isLabel(requestedLabel) || !isLabel(answeredLabel) || !REASONS.has(reason)) return null;
  return { requestedLabel: requestedLabel.trim(), answeredLabel: answeredLabel.trim(), reason };
};

const readStreamChunk = (line) => {
  if (!line.startsWith('data:')) return null;
  const value = parseJson(line.slice('data:'.length).trim());
  return value && typeof value === 'object' && Array.isArray(value.choices) ? value : null;
};

const newRequest = () => ({ decoder: new TextDecoder(), text: '', mode: null, settled: false });

export const createAnsweredByWatcher = (cb) => {
  const requests = new Map();

  const requestOf = (key) => {
    let request = requests.get(key);
    if (!request) {
      request = newRequest();
      requests.set(key, request);
      while (requests.size > REQUESTS_WATCHED) requests.delete(requests.keys().next().value);
    }
    return request;
  };

  const settle = (request, event, value) => {
    request.settled = true;
    request.text = '';
    const answeredBy = readAnsweredBy(value);
    if (answeredBy) cb(event.sessionId, { at: event.startedAt, model: event.model, ...answeredBy });
  };

  const take = (request, event, bytes) => {
    request.text += request.decoder.decode(bytes, { stream: true });
    if (request.mode === null) {
      const first = request.text.trimStart()[0];
      if (first === undefined) return;
      request.mode = first === '{' ? 'body' : 'stream';
    }
    if (request.mode === 'body') {
      if (request.text.length > BODY_LIMIT) request.settled = true;
      return;
    }
    const lines = request.text.split('\n');
    request.text = lines.pop() ?? '';
    for (const line of lines) {
      const chunk = readStreamChunk(line.trimEnd());
      if (chunk) {
        settle(request, event, chunk);
        return;
      }
    }
  };

  const finish = (request, event) => {
    request.text += request.decoder.decode();
    if (request.mode === 'body') {
      settle(request, event, request.text);
      return;
    }
    const chunk = readStreamChunk(request.text.trimEnd());
    if (chunk) settle(request, event, chunk);
  };

  return (event) => {
    try {
      if (!event || !event.sessionId || !event.model) return;
      const key = `${event.sessionId}\n${event.model}\n${event.startedAt}`;
      if (event.done) {
        const request = requests.get(key);
        requests.delete(key);
        if (request && !request.settled) finish(request, event);
        return;
      }
      const request = requestOf(key);
      if (!request.settled && event.chunk?.length) take(request, event, event.chunk);
    } catch {
      requests.clear();
    }
  };
};

export const createAnsweredByLog = ({ perSession = ANSWERS_PER_SESSION, sessions = SESSIONS_KEPT } = {}) => {
  const bySession = new Map();

  const record = (sessionId, answer) => {
    const answers = bySession.get(sessionId) ?? [];
    bySession.delete(sessionId);
    bySession.set(sessionId, [...answers, answer].slice(-perSession));
    while (bySession.size > sessions) bySession.delete(bySession.keys().next().value);
  };

  const list = (sessionId) => bySession.get(sessionId) ?? [];

  const clear = () => bySession.clear();

  return { record, list, clear };
};

export function registerAnsweredByRoute(app, { log, now = Date.now }) {
  app.get('/api/mittr/answered-by', (req, res) => {
    const sessionId = typeof req.query?.sessionId === 'string' ? req.query.sessionId.trim() : '';
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required', reasonCode: 'invalid_request' });
    return res.json({
      now: now(),
      answers: log.list(sessionId).map(({ at, model, reason, requestedLabel, answeredLabel }) => ({
        at, model, reason, requestedLabel, answeredLabel,
      })),
    });
  });
}

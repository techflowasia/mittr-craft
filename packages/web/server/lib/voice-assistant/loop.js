import { VOICE_CHROME_SESSION_ID } from './context.js';
import { VOICE_ACTION_TITLES } from './tools.js';

const VOICE_STEP_CAP = Object.freeze({ fallback: 8, min: 1, max: 20 });
const VOICE_TOOL_RESULT_MAX_CHARS = 20_000;
const MESSAGES_MAX_COUNT = 60;
const MESSAGES_MAX_CHARS = 200_000;
const STEP_TIMEOUT_MS = 120_000;
const PLATFORM_ERROR_CODES = new Set(['not_configured', 'upstream_failed', 'upstream_timeout', 'bad_request']);
const BUSY_STATUSES = new Set(['busy', 'retry']);
const IMAGE_FIELDS = new Set(['imageBase64', 'imageMime']);
const TRUNCATION_MARK = '…[truncated]';

const REASON_BY_STATUS = new Map([
  [400, 'invalid_request'],
  [401, 'not_signed_in'],
  [403, 'forbidden'],
  [404, 'not_found'],
  [409, 'conflict'],
  [499, 'cancelled'],
  [503, 'unavailable'],
  [504, 'timeout'],
]);

const CLOSING = {
  th: ({ steps, label }) => `หยุดไว้ก่อนหลังทำไป ${steps} ขั้น ขั้นล่าสุดคือ ${label} ถ้าจะให้ทำต่อ บอกได้เลย`,
  en: ({ steps, label }) => `I stopped after ${steps} steps; the last one was: ${label}. Tell me if you want me to carry on.`,
};

class TurnAborted extends Error {}

const readStepCap = async (readSettings) => {
  let settings = null;
  try {
    settings = await readSettings();
  } catch {
    settings = null;
  }
  const value = settings?.voiceStepCap;
  return Number.isInteger(value) && value >= VOICE_STEP_CAP.min && value <= VOICE_STEP_CAP.max ? value : VOICE_STEP_CAP.fallback;
};

const fitMessages = (history, turn) => {
  const kept = [...history];
  const size = (messages) => messages.reduce((total, message) => total + message.content.length, 0);
  const turnSize = size(turn);
  while (kept.length > 0 && (kept.length + turn.length > MESSAGES_MAX_COUNT || size(kept) + turnSize > MESSAGES_MAX_CHARS)) {
    kept.shift();
  }
  return [...kept, ...turn];
};

const serializeResult = (value) => {
  const json = JSON.stringify(value ?? null, (key, field) => (IMAGE_FIELDS.has(key) ? undefined : field)) ?? 'null';
  if (json.length <= VOICE_TOOL_RESULT_MAX_CHARS) return json;
  return `${json.slice(0, VOICE_TOOL_RESULT_MAX_CHARS - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`;
};

const errorResult = (error) => {
  const statusCode = Number(error?.statusCode);
  return {
    error: error instanceof Error ? error.message : String(error),
    reasonCode: typeof error?.code === 'string' ? error.code : (REASON_BY_STATUS.get(statusCode) ?? 'failed'),
  };
};

const parseArguments = (raw) => {
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { action, parameters, ...flattened } = parsed;
  const nested = parameters && typeof parameters === 'object' && !Array.isArray(parameters) ? parameters : {};
  return { action: typeof action === 'string' ? action : '', input: { ...flattened, ...nested } };
};

const parseSseBlock = (block) => {
  const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^\s/, '')).join('\n');
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
};

async function* readSse(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const event = parseSseBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (event) yield event;
      boundary = buffer.indexOf('\n\n');
    }
  }
  const tail = parseSseBlock(buffer.trim());
  if (tail) yield tail;
}

const stepErrorCode = async (response) => {
  if (response.status === 401 || response.status === 403) return 'not_signed_in';
  const body = await response.json().catch(() => null);
  if (typeof body?.code === 'string' && PLATFORM_ERROR_CODES.has(body.code)) return body.code;
  return response.status === 400 ? 'bad_request' : 'upstream_failed';
};

const untilAborted = (signal) => new Promise((_resolve, reject) => {
  if (!signal) return;
  if (signal.aborted) reject(new TurnAborted());
  else signal.addEventListener('abort', () => reject(new TurnAborted()), { once: true });
});

export const runVoiceTurn = async ({ said, history = [], locale, directory, sessionId, signal, emit, deps }) => {
  const {
    brokerBaseUrl,
    ensureFreshSession,
    fetchImpl = globalThis.fetch,
    controlService,
    readSettings,
    buildContext,
    describeSession,
    tools,
    chromePage,
    logger = console,
  } = deps;
  const turnSignal = signal ?? new AbortController().signal;
  const aborted = untilAborted(turnSignal);
  aborted.catch(() => undefined);
  const send = (event) => {
    if (!turnSignal.aborted) emit(event);
  };
  const guard = (work) => Promise.race([work, aborted]);

  const session = brokerBaseUrl && typeof ensureFreshSession === 'function' ? await ensureFreshSession().catch(() => null) : null;
  if (!session?.accessToken) {
    send({ type: 'error', code: 'not_signed_in' });
    return;
  }

  const allowed = Object.fromEntries(tools.map((tool) => [tool.name, tool.parameters?.properties?.action?.enum ?? []]));
  const conversation = history.map((entry) => ({ role: entry.role, content: entry.text }));
  const turn = [{ role: 'user', content: said }];

  const step = async (context) => {
    const timeout = AbortSignal.timeout(STEP_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(new URL('/desktop/voice/step', brokerBaseUrl).toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          Authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({ locale, context, messages: fitMessages(conversation, turn), tools }),
        signal: AbortSignal.any([turnSignal, timeout]),
      });
    } catch {
      if (turnSignal.aborted) throw new TurnAborted();
      return { error: timeout.aborted ? 'upstream_timeout' : 'upstream_failed' };
    }
    if (!response.ok) {
      const code = await stepErrorCode(response);
      logger.warn(`[voice] step request failed with HTTP ${response.status}`);
      return { error: code };
    }
    let text = '';
    const toolCalls = [];
    let finished = false;
    try {
      for await (const event of readSse(response.body)) {
        if (event.type === 'text-delta' && typeof event.text === 'string') {
          text += event.text;
          send({ type: 'text-delta', text: event.text });
        } else if (event.type === 'tool-call' && typeof event.id === 'string' && typeof event.name === 'string') {
          toolCalls.push({ id: event.id, name: event.name, arguments: typeof event.arguments === 'string' ? event.arguments : '{}' });
        } else if (event.type === 'error') {
          return { error: PLATFORM_ERROR_CODES.has(event.code) ? event.code : 'upstream_failed' };
        } else if (event.type === 'done') {
          finished = true;
          break;
        }
      }
    } catch {
      if (turnSignal.aborted) throw new TurnAborted();
      return { error: timeout.aborted ? 'upstream_timeout' : 'upstream_failed' };
    }
    if (!finished) {
      logger.warn('[voice] step stream ended without done');
      return { error: 'upstream_failed' };
    }
    return { text, toolCalls };
  };

  const dispatch = async (action, input) => {
    if (action === 'session.send') {
      const target = await describeSession(input.sessionId, input.directory || directory);
      if (!target || target.status === 'unknown') {
        return { ok: false, result: { error: 'Could not tell whether the session is busy, so nothing was sent', reasonCode: 'status_unavailable' } };
      }
      if (BUSY_STATUSES.has(target.status)) {
        send({ type: 'queue', sessionId: target.id, directory: target.directory, text: input.prompt ?? '' });
        return { ok: true, result: { queued: true, sessionId: target.id, note: 'The session is busy; the prompt will run after its current answer' } };
      }
    }
    const data = await controlService.execute(action, input, directory, { signal: turnSignal, sessionId: VOICE_CHROME_SESSION_ID });
    return { ok: true, result: data };
  };

  const runTool = async (call) => {
    const parsed = parseArguments(call.arguments);
    const permitted = parsed && Object.hasOwn(allowed, call.name) && allowed[call.name].includes(parsed.action);
    if (!permitted) {
      return { ok: false, action: null, result: { error: `${call.name} does not offer action ${parsed?.action || 'missing'}`, reasonCode: 'unsupported_action' } };
    }
    send({ type: 'action', kind: 'running', label: VOICE_ACTION_TITLES[parsed.action] ?? parsed.action });
    try {
      const outcome = await guard(dispatch(parsed.action, parsed.input));
      return { ...outcome, action: parsed.action };
    } catch (error) {
      if (error instanceof TurnAborted || turnSignal.aborted) throw new TurnAborted();
      return { ok: false, action: parsed.action, result: errorResult(error) };
    }
  };

  try {
    const cap = await guard(readStepCap(readSettings));
    let lastLabel = null;
    for (let stepNumber = 1; stepNumber <= cap; stepNumber += 1) {
      const context = await guard(buildContext({ directory, sessionId }));
      const outcome = await guard(step(context));
      if (outcome.error) {
        send({ type: 'error', code: outcome.error });
        return;
      }
      if (outcome.toolCalls.length === 0) {
        send({ type: 'done' });
        return;
      }
      turn.push({ role: 'assistant', content: outcome.text, toolCalls: outcome.toolCalls });
      for (const call of outcome.toolCalls) {
        const { ok, action, result } = await runTool(call);
        if (action && action.startsWith('chrome.')) chromePage?.note(action, ok);
        if (action) lastLabel = VOICE_ACTION_TITLES[action];
        turn.push({ role: 'tool', toolCallId: call.id, name: call.name, content: serializeResult(result) });
        send({ type: 'tool-result', id: call.id, ok });
      }
    }
    const closing = (CLOSING[locale] ?? CLOSING.en)({ steps: cap, label: lastLabel ?? '-' });
    send({ type: 'text-delta', text: closing });
    send({ type: 'done' });
  } catch (error) {
    if (error instanceof TurnAborted || turnSignal.aborted) return;
    throw error;
  }
};

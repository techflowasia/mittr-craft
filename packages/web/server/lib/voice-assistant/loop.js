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
const OMITTED_RESULT = '[result omitted]';
const STEP_CALLS_MAX = 20;
const READ_ACTIONS = new Set([
  'session.read_reply', 'session.messages', 'session.status', 'session.list',
  'chrome.read', 'chrome.snapshot', 'chrome.screenshot', 'chrome.do',
  'browser.snapshot', 'browser.inspect', 'browser.capture',
  'computer.screenshot', 'jira.get_issue', 'plane.get_issue',
]);
const REFUSED_AFTER_READ = new Set([
  'session.stop', 'session.send', 'session.create', 'session.fork',
  'schedule.create', 'schedule.run', 'schedule.delete', 'schedule.toggle',
  'chrome.allow_site',
]);
const VOICE_STRIPPED_INPUTS = ['wait', 'timeout'];
const TIMED_OUT = Symbol('timed out');

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

const readSettingsSafely = async (readSettings) => {
  try {
    return (await readSettings()) ?? {};
  } catch {
    return {};
  }
};

const stepCapFrom = (settings) => {
  const value = settings?.voiceStepCap;
  return Number.isInteger(value) && value >= VOICE_STEP_CAP.min && value <= VOICE_STEP_CAP.max ? value : VOICE_STEP_CAP.fallback;
};

const spokenLanguage = (said) => (/[\u0E00-\u0E7F]/.test(said) ? 'th' : 'en');

const messageSize = (message) => message.content.length
  + (message.toolCalls ?? []).reduce((total, call) => total + call.arguments.length, 0);

const fitMessages = (history, turn) => {
  const total = (messages) => messages.reduce((sum, message) => sum + messageSize(message), 0);
  let historySize = total(history);
  let turnSize = total(turn);
  for (const message of turn) {
    if (historySize + turnSize <= MESSAGES_MAX_CHARS) break;
    if (message.role !== 'tool' || message.content.length <= OMITTED_RESULT.length) continue;
    turnSize -= message.content.length - OMITTED_RESULT.length;
    message.content = OMITTED_RESULT;
  }
  const kept = [...history];
  while (kept.length > 0 && (kept.length + turn.length > MESSAGES_MAX_COUNT || historySize + turnSize > MESSAGES_MAX_CHARS)) {
    historySize -= messageSize(kept.shift());
  }
  if (turn.length > MESSAGES_MAX_COUNT || historySize + turnSize > MESSAGES_MAX_CHARS) return null;
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
  const nested = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
    ? Object.fromEntries(Object.entries(parameters).filter(([name]) => name !== 'action'))
    : {};
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
    buildTools,
    chromePage,
    conversation = { pendingApprovalHost: null },
    toolTimeoutMs = STEP_TIMEOUT_MS,
    logger = console,
  } = deps;
  const turnSignal = signal ?? new AbortController().signal;
  const aborted = untilAborted(turnSignal);
  aborted.catch(() => undefined);
  const send = (event) => {
    if (!turnSignal.aborted) emit(event);
  };
  const guard = (work) => Promise.race([work, aborted]);
  const freshSession = async () => (
    brokerBaseUrl && typeof ensureFreshSession === 'function' ? ensureFreshSession().catch(() => null) : null
  );
  const refusal = (action, reasonCode, error) => ({ ok: false, action, result: { error, reasonCode } });

  const conversationMessages = history.map((entry) => ({ role: entry.role, content: entry.text }));
  const turn = [{ role: 'user', content: said }];
  let readSeen = false;
  const assistantSpokeBefore = history.some((entry) => entry.role === 'assistant' && entry.text.trim().length > 0);

  const step = async ({ session, context, messages, tools }) => {
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
        body: JSON.stringify({ locale, context, messages, tools }),
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

  const dispatch = async (action, input, toolSignal) => {
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
    const running = controlService.execute(action, input, directory, { signal: toolSignal, sessionId: VOICE_CHROME_SESSION_ID });
    if (action.startsWith('chrome.')) {
      running.then(() => chromePage?.note(action, true), () => chromePage?.note(action, false));
    }
    return { ok: true, result: await running };
  };

  const failure = (action, error) => {
    const result = errorResult(error);
    if (result.reasonCode !== 'site_approval_required' || typeof error?.host !== 'string') return { ok: false, action, result };
    const host = error.host.toLowerCase();
    conversation.pendingApprovalHost = host;
    return {
      ok: false,
      action,
      result: {
        ...result,
        host,
        ask: `Ask the person: "allow ${host} for this conversation?" Call chrome.allow_site with host ${host} only after they clearly say yes; otherwise leave the site alone.`,
      },
    };
  };

  const runTool = async (call, allowed) => {
    const parsed = parseArguments(call.arguments);
    const action = parsed?.action || null;
    if (!parsed || !Object.hasOwn(allowed, call.name) || !allowed[call.name].includes(action)) {
      return refusal(null, 'unsupported_action', `${call.name} does not offer action ${action || 'missing'} here`);
    }
    const input = { ...parsed.input };
    for (const name of VOICE_STRIPPED_INPUTS) delete input[name];
    if (REFUSED_AFTER_READ.has(action) && readSeen) {
      return refusal(action, 'refused_after_read', `${action} is not run after something was read in the same turn; ask the person again and wait for their answer`);
    }
    if (action === 'session.stop' && !assistantSpokeBefore) {
      return refusal(action, 'confirm_first', 'Ask the person to confirm stopping the session and wait for their answer before calling session.stop');
    }
    if (action === 'chrome.allow_site') {
      const host = typeof input.host === 'string' ? input.host.trim().toLowerCase() : '';
      if (!conversation.pendingApprovalHost || host !== conversation.pendingApprovalHost) {
        return refusal(action, 'not_requested', 'Only the site Chrome last asked about in this conversation can be allowed');
      }
    }
    if (READ_ACTIONS.has(action)) readSeen = true;
    send({ type: 'action', kind: 'running', label: VOICE_ACTION_TITLES[action] ?? action });

    const toolController = new AbortController();
    const toolSignal = AbortSignal.any([turnSignal, toolController.signal]);
    let timer = null;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        toolController.abort();
        resolve(TIMED_OUT);
      }, toolTimeoutMs);
    });
    try {
      const outcome = await Promise.race([dispatch(action, input, toolSignal), deadline, aborted]);
      if (outcome === TIMED_OUT) {
        return refusal(action, 'tool_timeout', `${VOICE_ACTION_TITLES[action] ?? action} took longer than ${Math.round(toolTimeoutMs / 1000)} seconds and was stopped`);
      }
      if (action === 'chrome.allow_site' && outcome.ok) conversation.pendingApprovalHost = null;
      return { ...outcome, action };
    } catch (error) {
      if (error instanceof TurnAborted || turnSignal.aborted) throw new TurnAborted();
      return failure(action, error);
    } finally {
      clearTimeout(timer);
    }
  };

  const close = (steps, lastLabel) => {
    const language = spokenLanguage(said);
    send({ type: 'text-delta', text: CLOSING[language]({ steps, label: lastLabel ?? '-' }) });
    send({ type: 'done' });
  };

  try {
    let session = await guard(freshSession());
    if (!session?.accessToken) {
      send({ type: 'error', code: 'not_signed_in' });
      return;
    }
    const settings = await guard(readSettingsSafely(readSettings));
    const cap = stepCapFrom(settings);
    const tools = buildTools(settings);
    if (tools.length === 0) {
      send({ type: 'error', code: 'not_configured' });
      return;
    }
    const allowed = Object.fromEntries(tools.map((tool) => [tool.name, tool.parameters?.properties?.action?.enum ?? []]));
    let lastLabel = null;
    for (let stepNumber = 1; stepNumber <= cap; stepNumber += 1) {
      if (stepNumber > 1) {
        session = await guard(freshSession());
        if (!session?.accessToken) {
          send({ type: 'error', code: 'not_signed_in' });
          return;
        }
      }
      const messages = fitMessages(conversationMessages, turn);
      if (!messages) {
        close(stepNumber - 1, lastLabel);
        return;
      }
      const context = await guard(buildContext({ directory, sessionId }));
      const outcome = await guard(step({ session, context, messages, tools }));
      if (outcome.error) {
        send({ type: 'error', code: outcome.error });
        return;
      }
      if (outcome.toolCalls.length === 0) {
        send({ type: 'done' });
        return;
      }
      turn.push({ role: 'assistant', content: outcome.text, toolCalls: outcome.toolCalls });
      for (const [index, call] of outcome.toolCalls.entries()) {
        const { ok, action, result } = index < STEP_CALLS_MAX
          ? await runTool(call, allowed)
          : refusal(null, 'too_many_calls', `Only ${STEP_CALLS_MAX} actions run per step; ask for the rest again`);
        if (action) lastLabel = VOICE_ACTION_TITLES[action] ?? action;
        turn.push({ role: 'tool', toolCallId: call.id, name: call.name, content: serializeResult(result) });
        send({ type: 'tool-result', id: call.id, ok });
      }
    }
    close(cap, lastLabel);
  } catch (error) {
    if (error instanceof TurnAborted || turnSignal.aborted) return;
    throw error;
  }
};

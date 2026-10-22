import { readQuotaExhausted } from '../exhausted.js';
import { VOICE_STEP_TIMEOUT_MS } from '../platform.js';
import { pinAccount, sessionKeyOf } from '../tools/account-guard.js';
import { isRecord, trimmedText } from '../values.js';
import {
  MESSAGES_MAX_CHARS,
  MESSAGES_MAX_COUNT,
  READ_ACTIONS,
  STEP_CALLS_MAX,
  STEP_TIMEOUT_MS,
  VOICE_END_TITLE,
  VOICE_SESSION_ID,
  VOICE_STEP_CAP,
  VOICE_STRIPPED_INPUTS,
  VOICE_TOOLS,
  VOICE_TOOL_RESULT_MAX_CHARS,
  buildVoiceTools,
  guardCall,
  voiceActionTitles,
} from './tools.js';

const QUOTA = 'llm_quota_exhausted';
const PLATFORM_ERROR_CODES = new Set(['not_configured', 'upstream_failed', 'upstream_timeout', 'bad_request']);
const BUSY_STATUSES = new Set(['busy']);
const IMAGE_FIELDS = new Set(['imageBase64', 'imageMime', 'image']);
const TRUNCATION_MARK = '…[truncated]';
const OMITTED_RESULT = '[result omitted]';
const TIMED_OUT = Symbol('timed out');
const ACCOUNT_CHANGED = Symbol('account changed');
const UPSTREAM_NAMES = /\b(?:OpenChamber|OpenCode)\b/g;

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

const GOODBYE = {
  th: 'แล้วคุยกันใหม่นะครับ',
  en: 'Talk to you later.',
};

class TurnAborted extends Error {}

export const spokenLanguage = (said) => (/[฀-๿]/.test(said) ? 'th' : 'en');

const stepCapOf = (value) => (Number.isInteger(value) && value >= VOICE_STEP_CAP.min && value <= VOICE_STEP_CAP.max ? value : VOICE_STEP_CAP.fallback);

const messageSize = (message) => message.content.length
  + (message.toolCalls ?? []).reduce((total, call) => total + call.arguments.length, 0);

export const fitMessages = (history, turn) => {
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

export const serializeResult = (value) => {
  const json = JSON.stringify(value ?? null, (key, field) => (IMAGE_FIELDS.has(key) ? undefined : field)) ?? 'null';
  if (json.length <= VOICE_TOOL_RESULT_MAX_CHARS) return json;
  return `${json.slice(0, VOICE_TOOL_RESULT_MAX_CHARS - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`;
};

const errorResult = (error) => {
  const statusCode = Number(error?.statusCode ?? error?.status);
  const message = error instanceof Error ? error.message : String(error);
  return {
    error: message.replace(UPSTREAM_NAMES, 'MittrCraft'),
    reasonCode: trimmedText(error?.code) ?? (REASON_BY_STATUS.get(statusCode) ?? 'failed'),
  };
};

const parseArguments = (raw) => {
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed)) return null;
  const { action, parameters, ...flattened } = parsed;
  const nested = isRecord(parameters) ? Object.fromEntries(Object.entries(parameters).filter(([name]) => name !== 'action')) : {};
  return { action: trimmedText(action) ?? '', input: { ...flattened, ...nested } };
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

const quotaRefusal = (quota) => ({ error: QUOTA, resetsAt: quota.resetsAt ?? null });

const stepRefusal = async (response) => {
  if (response.status === 401 || response.status === 403) return { error: 'not_signed_in' };
  const body = await response.json().catch(() => null);
  const quota = readQuotaExhausted(body);
  if (quota) return quotaRefusal(quota);
  const code = trimmedText(body?.code);
  if (code && PLATFORM_ERROR_CODES.has(code)) return { error: code };
  return { error: response.status === 400 ? 'bad_request' : 'upstream_failed' };
};

const untilAborted = (signal) => new Promise((_resolve, reject) => {
  if (signal.aborted) reject(new TurnAborted());
  else signal.addEventListener('abort', () => reject(new TurnAborted()), { once: true });
});

export const runVoiceTurn = async ({ said, history = [], locale, directory, sessionId, queuedPrompts, panelOpen, conversationId, scope, signal, emit, deps }) => {
  const {
    broker,
    ensureFreshSession,
    fetchImpl = (...args) => fetch(...args),
    activeAccountKey,
    engineOnActiveHome,
    registry,
    upstream,
    switches,
    settings,
    buildContext,
    describeSession,
    conversation,
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
  const refusal = (action, reasonCode, error) => ({ ok: false, action, result: { error, reasonCode } });

  const pinned = pinAccount({ activeAccountKey, engineOnActiveHome });
  const sameAccount = (sessionKey) => {
    try {
      pinned(sessionKey);
      return true;
    } catch {
      return false;
    }
  };
  const freshSession = async () => {
    if (!sameAccount()) return ACCOUNT_CHANGED;
    const session = await Promise.resolve().then(ensureFreshSession).catch(() => null);
    if (!session?.accessToken) return null;
    return sameAccount(sessionKeyOf(session)) ? session : ACCOUNT_CHANGED;
  };

  const turn = [{ role: 'user', content: said }];
  const conversationMessages = history.map((entry) => ({ role: entry.role, content: entry.text }));
  const assistantSpokeBefore = history.some((entry) => entry.role === 'assistant' && entry.text.trim().length > 0);
  let readSeen = false;
  let titles = {};

  const step = async ({ session, context, messages, tools }) => {
    const timeout = AbortSignal.timeout(VOICE_STEP_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(new URL('/desktop/voice/step', broker.baseUrl).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ locale, context, messages, tools }),
        signal: AbortSignal.any([turnSignal, timeout]),
      });
    } catch {
      if (turnSignal.aborted) throw new TurnAborted();
      return { error: timeout.aborted ? 'upstream_timeout' : 'upstream_failed' };
    }
    if (!response.ok) {
      const refused = await stepRefusal(response);
      logger.warn(`[mittr] voice step answered HTTP ${response.status}`);
      return refused;
    }
    let text = '';
    const toolCalls = [];
    let finished = false;
    try {
      for await (const event of readSse(response.body)) {
        const quota = readQuotaExhausted(event);
        if (quota) return quotaRefusal(quota);
        if (event.type === 'text-delta' && event.text === String(event.text)) {
          text += event.text;
          send({ type: 'text-delta', text: event.text });
        } else if (event.type === 'tool-call' && trimmedText(event.id) && trimmedText(event.name)) {
          toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments === String(event.arguments) ? event.arguments : '{}' });
        } else if (event.type === 'error') {
          if (event.code === QUOTA) return quotaRefusal(event);
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
      logger.warn('[mittr] voice step stream ended without done');
      return { error: 'upstream_failed' };
    }
    return { text, toolCalls };
  };

  const queueOrSend = async (input, toolSignal) => {
    const target = await describeSession(input.sessionId, trimmedText(input.directory) ?? directory);
    if (!target || target.status === 'unknown') {
      return { ok: false, result: { error: 'Could not tell whether the session is busy, so nothing was sent', reasonCode: 'status_unavailable' } };
    }
    if (!BUSY_STATUSES.has(target.status)) return null;
    if (!target.sendConfig) {
      return { ok: false, result: { error: 'Could not tell which model that session uses, so nothing was queued', reasonCode: 'status_unavailable' } };
    }
    if (toolSignal.aborted) throw new TurnAborted();
    send({ type: 'queue', sessionId: target.id, directory: target.directory, text: input.prompt ?? '', sendConfig: target.sendConfig });
    return { ok: true, result: { queued: true, sessionId: target.id, note: 'The session is busy; the prompt will run after its current answer' } };
  };

  const dispatch = async (action, input, toolSignal) => {
    if (action === 'session.send') {
      const queued = await queueOrSend(input, toolSignal);
      if (queued) return queued;
    }
    const ctx = registry.has(action)
      ? { surface: 'voice', directory, sessionId: VOICE_SESSION_ID, conversationId, signal: toolSignal, headed: true, scope }
      : { surface: 'voice', directory, signal: toolSignal, scope };
    return { ok: true, result: await registry.execute(action, input, ctx) };
  };

  const failure = (action, error) => {
    const result = errorResult(error);
    const host = trimmedText(error?.host)?.toLowerCase();
    if (result.reasonCode !== 'site_approval_required' || !host) return { ok: false, action, result };
    conversation.setPendingHost(host);
    return {
      ok: false,
      action,
      result: {
        ...result,
        host,
        ask: `Ask the person once: "may I use Chrome for this conversation?" Call chrome.allow_site with host ${host} only after they clearly say yes; that allows every site until the conversation ends. Otherwise leave Chrome alone.`,
      },
    };
  };

  const runTool = async (call, allowed) => {
    if (call.name === VOICE_TOOLS.end && Object.hasOwn(allowed, call.name)) {
      send({ type: 'end' });
      return { ok: true, action: VOICE_TOOLS.end, result: { ending: true } };
    }
    const parsed = parseArguments(call.arguments);
    const action = parsed?.action || null;
    if (!parsed || !Object.hasOwn(allowed, call.name) || !Object.values(allowed).some((actions) => actions.includes(action))) {
      return refusal(null, 'unsupported_action', `${call.name} does not offer action ${action || 'missing'} here`);
    }
    const input = { ...parsed.input };
    for (const name of VOICE_STRIPPED_INPUTS) delete input[name];
    const checked = guardCall(action, { readSeen, assistantSpokeBefore, pendingHost: conversation.pendingHost(), chromeAllowed: conversation.chromeAllowed() });
    if (checked.refuse) return refusal(action, checked.refuse.reasonCode, checked.refuse.error);
    if (checked.answer) return { ok: true, action, result: checked.answer };
    if (READ_ACTIONS.has(action)) readSeen = true;
    send({ type: 'action', kind: 'running', label: titles[action] ?? action });

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
        return refusal(action, 'tool_timeout', `${titles[action] ?? action} took longer than ${Math.round(toolTimeoutMs / 1000)} seconds and was stopped`);
      }
      return { ...outcome, action };
    } catch (error) {
      if (error instanceof TurnAborted || turnSignal.aborted) throw new TurnAborted();
      return failure(action, error);
    } finally {
      clearTimeout(timer);
    }
  };

  const close = (steps, lastLabel) => {
    send({ type: 'text-delta', text: CLOSING[spokenLanguage(said)]({ steps, label: lastLabel ?? '-' }) });
    send({ type: 'done' });
  };

  const accountChanged = () => send({ type: 'error', code: 'account_changed' });

  try {
    let session = await guard(freshSession());
    if (session === ACCOUNT_CHANGED) return accountChanged();
    if (!session) return send({ type: 'error', code: 'not_signed_in' });
    const stored = await guard(Promise.resolve().then(() => settings()).catch(() => null));
    const cap = stepCapOf(stored?.voice?.stepCap);
    const on = await guard(Promise.resolve().then(() => switches()).catch(() => ({})));
    const tools = buildVoiceTools({ upstream, registry, switches: on });
    if (tools.length === 0) return send({ type: 'error', code: 'not_configured' });
    titles = voiceActionTitles({ upstream, registry });
    const allowed = Object.fromEntries(tools.map((tool) => [tool.name, tool.parameters?.properties?.action?.enum ?? []]));
    let lastLabel = null;
    for (let stepNumber = 1; stepNumber <= cap; stepNumber += 1) {
      if (stepNumber > 1) {
        session = await guard(freshSession());
        if (session === ACCOUNT_CHANGED) return accountChanged();
        if (!session) return send({ type: 'error', code: 'not_signed_in' });
      }
      const messages = fitMessages(conversationMessages, turn);
      if (!messages) return close(stepNumber - 1, lastLabel);
      const context = await guard(buildContext({ directory, sessionId, queuedPrompts, panelOpen }));
      if (!sameAccount()) return accountChanged();
      const outcome = await guard(step({ session, context, messages, tools }));
      if (outcome.error) {
        const refused = { type: 'error', code: outcome.error };
        if (outcome.error === QUOTA) refused.resetsAt = outcome.resetsAt;
        return send(refused);
      }
      if (outcome.toolCalls.length === 0) return send({ type: 'done' });
      turn.push({ role: 'assistant', content: outcome.text, toolCalls: outcome.toolCalls });
      let ending = false;
      for (const [index, call] of outcome.toolCalls.entries()) {
        if (!sameAccount()) return accountChanged();
        const { ok, action, result } = index < STEP_CALLS_MAX
          ? await runTool(call, allowed)
          : refusal(null, 'too_many_calls', `Only ${STEP_CALLS_MAX} actions run per step; ask for the rest again`);
        if (!sameAccount()) return accountChanged();
        if (action === VOICE_TOOLS.end && ok) ending = true;
        if (action) lastLabel = action === VOICE_TOOLS.end ? VOICE_END_TITLE : (titles[action] ?? action);
        turn.push({ role: 'tool', toolCallId: call.id, name: call.name, content: serializeResult(result) });
        send({ type: 'tool-result', id: call.id, ok });
      }
      if (ending) {
        if (!outcome.text.trim()) send({ type: 'text-delta', text: GOODBYE[spokenLanguage(said)] });
        return send({ type: 'done' });
      }
    }
    return close(cap, lastLabel);
  } catch (error) {
    if (error instanceof TurnAborted || turnSignal.aborted) return undefined;
    throw error;
  }
};

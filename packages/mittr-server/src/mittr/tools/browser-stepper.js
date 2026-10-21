import { keyOf } from '../account-store.js';
import { ACCOUNT_CHANGED, BROWSER_STEP_TIMEOUT_MS, callPlatform, platformErrorText } from '../platform.js';
import { isRecord } from '../values.js';
import { MittrToolError } from './registry.js';

export const MAX_GOAL_CHARS = 4_000;
export const MAX_HISTORY_ITEM_CHARS = 1_000;
export const MAX_STEP_TEXT_CHARS = 1_000;

const NEXT_STEP_ENDPOINT = '/desktop/browser/next-step';
const STEP_ACTIONS = new Set(['click', 'fill', 'select', 'done', 'ask', 'stop']);
const NEEDS_REF = new Set(['click', 'fill', 'select']);
const NEEDS_VALUE = new Set(['fill', 'select']);

const NO_USABLE_STEP = 'The Mittr platform returned no usable step';
const SIGN_IN_FIRST = 'Sign in to Mittr first';
const TOO_SLOW = 'The Mittr platform took too long to choose a step';
const ASKED_FALLBACK = 'The Mittr platform asked for your input';
const STOPPED_FALLBACK = 'The Mittr platform stopped';

const isText = (value) => value === String(value);

const boundedText = (value, fallback) => (isText(value) && value.trim() ? value.trim().slice(0, MAX_STEP_TEXT_CHARS) : fallback);

const usableStep = (step) => isRecord(step)
  && STEP_ACTIONS.has(step.action)
  && (!NEEDS_REF.has(step.action) || /^e\d+$/.test(isText(step.ref) ? step.ref : ''))
  && (!NEEDS_VALUE.has(step.action) || isText(step.value));

const stepOf = (step) => {
  if (step.action === 'ask') return { action: 'ask', question: boundedText(step.question, ASKED_FALLBACK) };
  if (step.action === 'stop') return { action: 'stop', reason: boundedText(step.reason, STOPPED_FALLBACK) };
  return step;
};

const readStep = (body) => {
  if (!isRecord(body) || !usableStep(body.step)) throw new MittrToolError(NO_USABLE_STEP, 502);
  return {
    step: stepOf(body.step),
    values: Array.isArray(body.values) ? body.values.filter(isText) : undefined,
    decidedBy: Array.isArray(body.decidedBy) ? body.decidedBy.filter(isText) : [],
    ms: Number.isFinite(body.ms) ? body.ms : null,
  };
};

const sessionKeyOf = (session) => {
  const userId = session?.subject?.userId;
  return isText(userId) && userId ? keyOf(userId) : null;
};

export function createBrowserStepper({
  broker,
  ensureFreshSession,
  engineOnActiveHome,
  activeAccountKey,
  fetchImpl = (...args) => fetch(...args),
  timeoutMs = BROWSER_STEP_TIMEOUT_MS,
} = {}) {
  if (!broker?.baseUrl || ![ensureFreshSession, engineOnActiveHome, activeAccountKey].every((dep) => dep instanceof Function)) return null;
  const endpoint = new URL(NEXT_STEP_ENDPOINT, broker.baseUrl).toString();

  const begin = () => {
    const pinned = activeAccountKey();
    const ensureSameAccount = (sessionKey = pinned) => {
      if (activeAccountKey() !== pinned || sessionKey !== pinned || engineOnActiveHome() !== true) {
        throw new MittrToolError(ACCOUNT_CHANGED, 409);
      }
    };

    const nextStep = async ({ goal, snapshot, history, values }, signal) => {
      ensureSameAccount();
      const session = await ensureFreshSession();
      if (!session?.accessToken) throw new MittrToolError(SIGN_IN_FIRST, 401);
      ensureSameAccount(sessionKeyOf(session));
      const request = { goal, snapshot, history: history.map((line) => line.slice(0, MAX_HISTORY_ITEM_CHARS)) };
      if (values) request.values = values;
      const { response, body, failure } = await callPlatform(fetchImpl, endpoint, {
        accessToken: session.accessToken,
        method: 'POST',
        body: request,
        timeoutMs,
        signal,
      });
      if (failure) throw new MittrToolError(failure.status === 504 ? TOO_SLOW : failure.error, failure.status);
      ensureSameAccount();
      if (!response.ok) throw new MittrToolError(platformErrorText(body) ?? `HTTP ${response.status}`, response.status);
      return readStep(body);
    };

    return { nextStep };
  };

  return { begin };
}

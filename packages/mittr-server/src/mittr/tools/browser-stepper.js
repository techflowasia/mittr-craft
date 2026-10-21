import { ACCOUNT_CHANGED, BROWSER_STEP_TIMEOUT_MS, callPlatform, platformErrorText } from '../platform.js';
import { isRecord } from '../values.js';
import { MittrToolError } from './registry.js';

const NEXT_STEP_ENDPOINT = '/desktop/browser/next-step';
const STEP_ACTIONS = new Set(['click', 'fill', 'select', 'done', 'ask', 'stop']);
const NEEDS_REF = new Set(['click', 'fill', 'select']);
const NEEDS_VALUE = new Set(['fill', 'select']);

const NO_USABLE_STEP = 'The Mittr platform returned no usable step';
const SIGN_IN_FIRST = 'Sign in to Mittr first';
const TOO_SLOW = 'The Mittr platform took too long to choose a step';

const isText = (value) => value === String(value);

const usableStep = (step) => isRecord(step)
  && STEP_ACTIONS.has(step.action)
  && (!NEEDS_REF.has(step.action) || /^e\d+$/.test(isText(step.ref) ? step.ref : ''))
  && (!NEEDS_VALUE.has(step.action) || isText(step.value));

const readStep = (body) => {
  if (!isRecord(body) || !usableStep(body.step)) throw new MittrToolError(NO_USABLE_STEP, 502);
  return {
    step: body.step,
    values: Array.isArray(body.values) ? body.values.filter(isText) : undefined,
    decidedBy: Array.isArray(body.decidedBy) ? body.decidedBy.filter(isText) : [],
    ms: Number.isFinite(body.ms) ? body.ms : null,
  };
};

export function createBrowserStepper({
  broker,
  ensureFreshSession,
  engineOnActiveHome,
  fetchImpl = (...args) => fetch(...args),
  timeoutMs = BROWSER_STEP_TIMEOUT_MS,
} = {}) {
  if (!broker?.baseUrl || !(ensureFreshSession instanceof Function) || !(engineOnActiveHome instanceof Function)) return null;
  const endpoint = new URL(NEXT_STEP_ENDPOINT, broker.baseUrl).toString();

  const ensureSameAccount = () => {
    if (engineOnActiveHome() !== true) throw new MittrToolError(ACCOUNT_CHANGED, 409);
  };

  const nextStep = async ({ goal, snapshot, history, values }, signal) => {
    ensureSameAccount();
    const session = await ensureFreshSession();
    if (!session?.accessToken) throw new MittrToolError(SIGN_IN_FIRST, 401);
    const request = { goal, snapshot, history };
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
}

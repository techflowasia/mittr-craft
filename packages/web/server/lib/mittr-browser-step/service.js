const REQUEST_TIMEOUT_MS = 30_000;
const STEP_ACTIONS = new Set(['click', 'fill', 'select', 'done', 'ask', 'stop']);

const createHttpError = (message, statusCode) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const readStep = (body) => {
  const step = body?.step;
  if (!step || typeof step !== 'object' || !STEP_ACTIONS.has(step.action)) {
    throw createHttpError('The Mittr platform returned no usable step', 502);
  }
  if (['click', 'fill', 'select'].includes(step.action) && !/^e\d+$/.test(String(step.ref ?? ''))) {
    throw createHttpError('The Mittr platform returned a step without an element ref', 502);
  }
  if (['fill', 'select'].includes(step.action) && typeof step.value !== 'string') {
    throw createHttpError('The Mittr platform returned a step without a value', 502);
  }
  return {
    step,
    values: Array.isArray(body.values) ? body.values.filter((value) => typeof value === 'string') : undefined,
    decidedBy: Array.isArray(body.decidedBy) ? body.decidedBy.filter((value) => typeof value === 'string') : [],
    ms: Number.isFinite(body.ms) ? body.ms : null,
  };
};

/**
 * Asks the Mittr platform for the next step on a Chrome page, with the desktop session
 * that already gates the app. The platform owns the decision model and its credentials;
 * this install never holds them.
 */
export const createMittrBrowserStepper = ({
  brokerBaseUrl,
  ensureFreshSession,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) => {
  if (!brokerBaseUrl || typeof ensureFreshSession !== 'function') return null;

  const nextStep = async ({ goal, snapshot, history, values }, signal) => {
    const session = await ensureFreshSession();
    if (!session) throw createHttpError('Sign in to Mittr first', 401);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetchImpl(new URL('/desktop/browser/next-step', brokerBaseUrl).toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({ goal, snapshot, history, ...(values ? { values } : {}) }),
        signal: combined,
      });
    } catch (error) {
      if (timeout.aborted) throw createHttpError('The Mittr platform took too long to choose a step', 504);
      throw createHttpError(error instanceof Error ? error.message : 'Request failed', 502);
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = typeof body?.message === 'string' && body.message ? body.message : `HTTP ${response.status}`;
      throw createHttpError(message, response.status);
    }
    return readStep(body);
  };

  return { nextStep };
};

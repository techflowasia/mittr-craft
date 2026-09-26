const REQUEST_TIMEOUT_MS = 60_000;
const VERDICTS = new Set(['met', 'missing', 'needs_person']);

const createHttpError = (message, statusCode) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const readJudgement = (body, askedIds) => {
  if (!Array.isArray(body?.results)) {
    throw createHttpError('The Mittr platform returned no judgement', 502);
  }
  const results = body.results
    .filter((entry) => askedIds.has(entry?.id) && VERDICTS.has(entry?.verdict))
    .map((entry) => ({ id: entry.id, verdict: entry.verdict, why: typeof entry.why === 'string' ? entry.why : '' }));
  return {
    results,
    decidedBy: Array.isArray(body.decidedBy) ? [...new Set(body.decidedBy.filter((value) => typeof value === 'string'))] : [],
    ms: Number.isFinite(body.ms) ? body.ms : null,
  };
};

export const createMittrGoalJudge = ({
  brokerBaseUrl,
  ensureFreshSession,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) => {
  if (!brokerBaseUrl || typeof ensureFreshSession !== 'function') return null;

  const judge = async ({ objective, criteria, evidence, report }, signal) => {
    const session = await ensureFreshSession();
    if (!session) throw createHttpError('Sign in to Mittr first', 401);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetchImpl(new URL('/desktop/goal/judge', brokerBaseUrl).toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({ objective, criteria, evidence, report }),
        signal: combined,
      });
    } catch (error) {
      if (timeout.aborted) throw createHttpError('The Mittr platform took too long to judge the goal', 504);
      throw createHttpError(error instanceof Error ? error.message : 'Request failed', 502);
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = typeof body?.message === 'string' && body.message ? body.message : `HTTP ${response.status}`;
      throw createHttpError(message, response.status);
    }
    return readJudgement(body, new Set(criteria.map((criterion) => criterion.id)));
  };

  return { judge };
};

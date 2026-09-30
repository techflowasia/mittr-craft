const REQUEST_TIMEOUT_MS = 10_000;
const KINDS = new Set(['chat', 'image', 'stt', 'tts']);
const SOURCES = new Set(['default', 'group', 'user', 'none']);

const STATUS_BY_REASON = {
  not_signed_in: 401,
  not_available: 404,
  upstream_failed: 502,
  unreachable: 502,
  upstream_timeout: 504,
};

const createQuotaReadError = (reasonCode, statusCode = STATUS_BY_REASON[reasonCode] ?? 502) => (
  Object.assign(new Error(`Mittr quota read failed: ${reasonCode}`), { reasonCode, statusCode })
);

const isTime = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const isAmount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

const readLine = (line) => {
  if (!line || typeof line !== 'object') return null;
  const { modelKey, kind, label, used, limit, source } = line;
  if (typeof modelKey !== 'string' || typeof label !== 'string' || !KINDS.has(kind)) return null;
  if (!isAmount(used) || !isAmount(limit) || limit <= 0 || !SOURCES.has(source)) return null;
  return { modelKey, kind, label, used, limit, source };
};

const readQuotaMe = (body) => {
  if (!body || typeof body !== 'object' || !isTime(body.weekStart) || !isTime(body.resetsAt) || !Array.isArray(body.lines)) {
    return null;
  }
  return {
    weekStart: body.weekStart,
    resetsAt: body.resetsAt,
    lines: body.lines.map(readLine).filter(Boolean),
  };
};

export const createMittrQuotaService = ({ brokerBaseUrl, ensureFreshSession, fetchImpl = globalThis.fetch } = {}) => {
  const configured = Boolean(brokerBaseUrl && typeof ensureFreshSession === 'function');

  const readMine = async () => {
    if (!configured) throw createQuotaReadError('unreachable', 503);
    const session = await ensureFreshSession();
    if (!session?.accessToken) throw createQuotaReadError('not_signed_in');

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(new URL('/api/quota/me', brokerBaseUrl).toString(), {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${session.accessToken}` },
        signal: timeout,
      });
    } catch {
      throw createQuotaReadError(timeout.aborted ? 'upstream_timeout' : 'unreachable');
    }
    if (response.status === 401 || response.status === 403) throw createQuotaReadError('not_signed_in');
    if (response.status === 404) throw createQuotaReadError('not_available');
    if (!response.ok) throw createQuotaReadError('upstream_failed');
    const quota = readQuotaMe(await response.json().catch(() => null));
    if (!quota) throw createQuotaReadError('upstream_failed');
    return quota;
  };

  return { readMine };
};

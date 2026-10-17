const REQUEST_TIMEOUT_MS = 10_000;
const QUOTA_ENDPOINT = '/api/quota/me';
const KINDS = new Set(['chat', 'image', 'stt', 'tts']);
const SOURCES = new Set(['default', 'group', 'user', 'none']);
const AGENT_STATES = new Set(['ok', 'near', 'substitute', 'out']);
const LABEL_KEY = /^quota\.[A-Za-z.]+$/;

const STATUS_BY_REASON = {
  not_signed_in: 401,
  not_available: 404,
  upstream_failed: 502,
  unreachable: 502,
  upstream_timeout: 504,
  not_configured: 503,
};

const createQuotaReadError = (reasonCode) => (
  Object.assign(new Error(`Mittr quota read failed: ${reasonCode}`), { reasonCode, statusCode: STATUS_BY_REASON[reasonCode] })
);

const isTime = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const isAmount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

const readAgents = (agents) => {
  if (!Array.isArray(agents)) return [];
  return agents
    .filter((agent) => agent && typeof agent.key === 'string' && typeof agent.label === 'string' && agent.label)
    .map(({ key, label }) => ({ key, label }));
};

const readLine = (line) => {
  if (!line || typeof line !== 'object') return null;
  const { modelKey, kind, label, used, limit, source, labelKey } = line;
  if (typeof modelKey !== 'string' || typeof label !== 'string' || !KINDS.has(kind)) return null;
  if (!isAmount(used) || !isAmount(limit) || limit <= 0 || !SOURCES.has(source)) return null;
  const agents = readAgents(line.agents);
  return {
    modelKey,
    kind,
    label,
    ...(typeof labelKey === 'string' && LABEL_KEY.test(labelKey) ? { labelKey } : {}),
    used,
    limit,
    source,
    ...(agents.length ? { agents } : {}),
  };
};

const readAgentStatus = (value) => {
  if (!value || typeof value !== 'object') return null;
  const { modelKey, left, limit, resetsAt, state, percentLeft, substituteLabel } = value;
  if (typeof modelKey !== 'string' || !isAmount(left) || !isAmount(limit) || !isTime(resetsAt) || !AGENT_STATES.has(state)) {
    return null;
  }
  return {
    modelKey,
    left,
    limit,
    resetsAt,
    state,
    ...(isAmount(percentLeft) ? { percentLeft } : {}),
    ...(typeof substituteLabel === 'string' && substituteLabel ? { substituteLabel } : {}),
  };
};

const readAgentStatuses = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const statuses = {};
  for (const [alias, raw] of Object.entries(value)) {
    const status = readAgentStatus(raw);
    if (status) statuses[alias] = status;
  }
  return Object.keys(statuses).length ? statuses : null;
};

const readQuotaMe = (body) => {
  if (!body || typeof body !== 'object' || !isTime(body.weekStart) || !isTime(body.resetsAt) || !Array.isArray(body.lines)) {
    return null;
  }
  const agentStatus = readAgentStatuses(body.agentStatus);
  return {
    weekStart: body.weekStart,
    resetsAt: body.resetsAt,
    lines: body.lines.map(readLine).filter(Boolean),
    ...(agentStatus ? { agentStatus } : {}),
  };
};

export const createMittrQuotaService = ({
  broker,
  ensureFreshSession,
  fetchImpl = (...args) => fetch(...args),
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) => {
  const configured = Boolean(broker?.baseUrl) && typeof ensureFreshSession === 'function';

  const readMine = async () => {
    if (!configured) throw createQuotaReadError('not_configured');
    const session = await ensureFreshSession();
    if (!session?.accessToken) throw createQuotaReadError('not_signed_in');

    const timeout = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(new URL(QUOTA_ENDPOINT, broker.baseUrl).toString(), {
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

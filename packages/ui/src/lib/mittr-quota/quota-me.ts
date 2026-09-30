import type { QuotaKind } from './exhausted';

const QUOTA_LABEL_KEYS = [
  'quota.role.decision',
  'quota.role.decisionRoute',
  'quota.role.tools',
  'quota.role.prose',
  'quota.role.rerank',
  'quota.role.image',
  'quota.role.visionCheck',
  'quota.role.manager',
  'quota.role.default',
  'quota.model.other',
  'quota.fallback.label',
] as const;

export type QuotaLabelKey = (typeof QUOTA_LABEL_KEYS)[number];

export interface QuotaAgentRef {
  key: string;
  label: string;
}

export interface QuotaUsageLine {
  modelKey: string;
  kind: QuotaKind;
  label: string;
  labelKey?: QuotaLabelKey;
  used: number;
  limit: number;
  agents?: QuotaAgentRef[];
}

export type QuotaAgentState = 'ok' | 'near' | 'substitute' | 'out';

export interface QuotaAgentStatus {
  modelKey: string;
  left: number;
  limit: number;
  resetsAt: string;
  state: QuotaAgentState;
  percentLeft?: number;
  substituteLabel?: string;
}

export interface QuotaMe {
  weekStart: string;
  resetsAt: string;
  lines: QuotaUsageLine[];
  agentStatus?: Record<string, QuotaAgentStatus>;
}

export type QuotaMeResult =
  | { status: 'ok'; quota: QuotaMe }
  | { status: 'not_signed_in' }
  | { status: 'unreachable' }
  | { status: 'not_available' }
  | { status: 'failed' };

type QuotaFetch = (input: string, init?: RequestInit) => Promise<Response>;

const KINDS: ReadonlySet<string> = new Set<QuotaKind>(['chat', 'image', 'stt', 'tts']);
const LABEL_KEYS: ReadonlySet<string> = new Set<string>(QUOTA_LABEL_KEYS);
const AGENT_STATES: ReadonlySet<string> = new Set<QuotaAgentState>(['ok', 'near', 'substitute', 'out']);

const isTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

const readAgents = (value: unknown): QuotaAgentRef[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const agent = entry as Record<string, unknown>;
    return typeof agent.key === 'string' && typeof agent.label === 'string' && agent.label
      ? [{ key: agent.key, label: agent.label }]
      : [];
  });
};

const readLine = (value: unknown): QuotaUsageLine | null => {
  if (!value || typeof value !== 'object') return null;
  const line = value as Record<string, unknown>;
  if (typeof line.modelKey !== 'string' || typeof line.label !== 'string') return null;
  if (typeof line.kind !== 'string' || !KINDS.has(line.kind)) return null;
  if (!isAmount(line.used) || !isAmount(line.limit) || line.limit <= 0) return null;
  const agents = readAgents(line.agents);
  return {
    modelKey: line.modelKey,
    kind: line.kind as QuotaKind,
    label: line.label,
    ...(typeof line.labelKey === 'string' && LABEL_KEYS.has(line.labelKey) ? { labelKey: line.labelKey as QuotaLabelKey } : {}),
    used: line.used,
    limit: line.limit,
    ...(agents.length ? { agents } : {}),
  };
};

const readAgentStatus = (value: unknown): QuotaAgentStatus | null => {
  if (!value || typeof value !== 'object') return null;
  const status = value as Record<string, unknown>;
  if (typeof status.modelKey !== 'string' || !isAmount(status.left) || !isAmount(status.limit)) return null;
  if (!isTime(status.resetsAt) || typeof status.state !== 'string' || !AGENT_STATES.has(status.state)) return null;
  return {
    modelKey: status.modelKey,
    left: status.left,
    limit: status.limit,
    resetsAt: status.resetsAt,
    state: status.state as QuotaAgentState,
    ...(isAmount(status.percentLeft) ? { percentLeft: status.percentLeft } : {}),
    ...(typeof status.substituteLabel === 'string' && status.substituteLabel ? { substituteLabel: status.substituteLabel } : {}),
  };
};

const readAgentStatuses = (value: unknown): Record<string, QuotaAgentStatus> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const statuses: Record<string, QuotaAgentStatus> = {};
  for (const [key, raw] of Object.entries(value)) {
    const status = readAgentStatus(raw);
    if (status) statuses[key] = status;
  }
  return Object.keys(statuses).length ? statuses : undefined;
};

export function parseQuotaMe(value: unknown): QuotaMe | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (!isTime(body.weekStart) || !isTime(body.resetsAt) || !Array.isArray(body.lines)) return null;
  const agentStatus = readAgentStatuses(body.agentStatus);
  return {
    weekStart: body.weekStart,
    resetsAt: body.resetsAt,
    lines: body.lines.map(readLine).filter((line): line is QuotaUsageLine => line !== null),
    ...(agentStatus ? { agentStatus } : {}),
  };
}

export async function fetchQuotaMe(fetchImpl: QuotaFetch, signal?: AbortSignal): Promise<QuotaMeResult> {
  let response: Response;
  try {
    response = await fetchImpl('/api/mittr/quota/me', { method: 'GET', signal });
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    return { status: 'unreachable' };
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { reasonCode?: unknown } | null;
    const reasonCode = body?.reasonCode;
    if (response.status === 401) return { status: 'not_signed_in' };
    if (response.status === 404 || reasonCode === 'not_configured') return { status: 'not_available' };
    if (reasonCode === 'unreachable' || response.status === 503 || response.status === 504) return { status: 'unreachable' };
    return { status: 'failed' };
  }
  const quota = parseQuotaMe(await response.json().catch(() => null));
  return quota ? { status: 'ok', quota } : { status: 'failed' };
}

export function usedPercent(line: QuotaUsageLine): number {
  return Math.min(100, Math.round((line.used / line.limit) * 100));
}

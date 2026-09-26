import type { Session } from '@opencode-ai/sdk/v2';

// Session goal driven by the server's session-goal runtime, stored under
// session.metadata.mittrcraft.goal. The UI writes goals (create/edit/
// pause/resume/clear) by patching this metadata; the server loop accounts
// usage, audits progress with the small model, and auto-continues the
// session until the goal settles.
export type SessionGoalStatus = 'active' | 'paused' | 'blocked' | 'budgetLimited' | 'complete';

const SESSION_GOAL_STATUSES: SessionGoalStatus[] = ['active', 'paused', 'blocked', 'budgetLimited', 'complete'];

export const SESSION_GOAL_OBJECTIVE_CHAR_LIMIT = 5000;

export type SessionGoalCriterionStatus = 'pending' | 'met' | 'missing' | 'needs_person';
export type SessionGoalCriterionCheck = 'judge' | 'file' | 'command' | 'sources';
export type SessionGoalCriterionJudge = 'script' | 'mittr' | 'model' | '';

export interface SessionGoalCriterion {
  id: string;
  text: string;
  check: SessionGoalCriterionCheck;
  status: SessionGoalCriterionStatus;
  reason: string;
  by: SessionGoalCriterionJudge;
}

const CRITERION_STATUSES: SessionGoalCriterionStatus[] = ['pending', 'met', 'missing', 'needs_person'];
const CRITERION_CHECKS: SessionGoalCriterionCheck[] = ['judge', 'file', 'command', 'sources'];
const CRITERION_JUDGES: SessionGoalCriterionJudge[] = ['script', 'mittr', 'model'];

export interface SessionGoalPayload {
  id: string;
  objective: string;
  /** True when the objective text lives in a server-side file keyed by session id. */
  objectiveFile: boolean;
  status: SessionGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  turnsUsed: number;
  blockedStreak: number;
  note: string;
  statusReason: string;
  evaluationProviderID: string;
  evaluationModelID: string;
  lastAccountedMessageID: string;
  criteria: SessionGoalCriterion[];
  createdAt: number;
  updatedAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isGoalStatus = (value: unknown): value is SessionGoalStatus =>
  typeof value === 'string' && (SESSION_GOAL_STATUSES as string[]).includes(value);

const oneOf = <T extends string>(values: readonly T[], value: unknown, fallback: T): T =>
  typeof value === 'string' && (values as readonly string[]).includes(value) ? value as T : fallback;

const parseCriteria = (value: unknown): SessionGoalCriterion[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): SessionGoalCriterion[] => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.text !== 'string' || !entry.text.trim()) return [];
    const check = isRecord(entry.check) ? entry.check.type : undefined;
    return [{
      id: entry.id,
      text: entry.text.trim(),
      check: oneOf(CRITERION_CHECKS, check, 'judge'),
      status: oneOf(CRITERION_STATUSES, entry.status, 'pending'),
      reason: typeof entry.reason === 'string' ? entry.reason : '',
      by: oneOf(CRITERION_JUDGES, entry.by, ''),
    }];
  });
};

export function getSessionGoal(session: Session | null | undefined): SessionGoalPayload | null {
  const metadata = (session as { metadata?: unknown } | null | undefined)?.metadata;
  if (!isRecord(metadata)) return null;
  const namespace = metadata.mittrcraft;
  if (!isRecord(namespace)) return null;
  const goal = namespace.goal;
  if (!isRecord(goal)) return null;

  const id = typeof goal.id === 'string' ? goal.id : '';
  const objective = typeof goal.objective === 'string' ? goal.objective.trim() : '';
  const objectiveFile = goal.objectiveFile === true;
  if (!id || (!objective && !objectiveFile) || !isGoalStatus(goal.status)) return null;

  const tokenBudget = typeof goal.tokenBudget === 'number' && Number.isFinite(goal.tokenBudget) && goal.tokenBudget > 0
    ? Math.floor(goal.tokenBudget)
    : null;
  const asCount = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

  return {
    id,
    objective: objective.slice(0, SESSION_GOAL_OBJECTIVE_CHAR_LIMIT),
    objectiveFile,
    status: goal.status,
    tokenBudget,
    tokensUsed: asCount(goal.tokensUsed),
    turnsUsed: asCount(goal.turnsUsed),
    blockedStreak: asCount(goal.blockedStreak),
    note: typeof goal.note === 'string' ? goal.note : '',
    statusReason: typeof goal.statusReason === 'string' ? goal.statusReason : '',
    evaluationProviderID: typeof goal.evaluationProviderID === 'string' ? goal.evaluationProviderID : '',
    evaluationModelID: typeof goal.evaluationModelID === 'string' ? goal.evaluationModelID : '',
    lastAccountedMessageID: typeof goal.lastAccountedMessageID === 'string' ? goal.lastAccountedMessageID : '',
    criteria: parseCriteria(goal.criteria),
    createdAt: typeof goal.createdAt === 'number' ? goal.createdAt : 0,
    updatedAt: typeof goal.updatedAt === 'number' ? goal.updatedAt : 0,
  };
}

export function formatGoalTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 10_000) return `${Math.round(count / 1000)}K`;
  if (count >= 1_000) return `${(count / 1000).toFixed(1)}K`;
  return String(count);
}

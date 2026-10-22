import type { Session, SessionStatus } from '../../../ui/src/lib/opencode/model';
import { formatGoalTokens, getSessionGoal, type SessionGoalPayload } from '../../../ui/src/lib/sessionGoalMetadata';
import { resolveGlobalSessionDirectory } from '../../../ui/src/stores/globalSessionStructure';
import type { PendingBlockingRequests } from '../../../ui/src/sync/global-blocking-requests';
import type { QuotaMeState } from '../quota/quotaMeStore';
import { mittrT, type MittrKey } from '../strings/mittrT';
import type { MyWorkState } from '../work/myWorkController';
import type { WorkItem } from '../work/workItems';

export type TodayKind = 'approval' | 'question' | 'review' | 'goal' | 'running' | 'scheduled' | 'quota' | 'error' | 'due' | 'work' | 'widget';

export type TodayRow = { id: string; kind: TodayKind; title: string; detail: string; open(): void };

export type TodayActions = {
  session: (id: string, directory: string | null) => void;
  settings: (page: string) => void;
  work: (item: WorkItem) => void;
  scheduledTasks: () => void;
};

export type ScheduledRun = { id: string; name: string; projectId: string };

export const SCHEDULED_RUN_MAX_MS = 30 * 60 * 1000;

type ScheduledTaskLike = { id: string; name: string; state?: { lastStatus?: string; lastRunAt?: number } };

export function scheduledRunsOf(projectId: string, tasks: readonly ScheduledTaskLike[], now: number): ScheduledRun[] {
  return tasks
    .filter((task) => {
      const at = task.state?.lastRunAt;
      return task.state?.lastStatus === 'running' && typeof at === 'number' && now - at >= 0 && now - at < SCHEDULED_RUN_MAX_MS;
    })
    .map((task) => ({ id: task.id, name: task.name, projectId }));
}

export type TodayState = {
  sessions: readonly Session[];
  statusById: ReadonlyMap<string, { status: SessionStatus; directory: string }>;
  blocking: ReadonlyMap<string, PendingBlockingRequests>;
  unseenCount: Readonly<Record<string, number>>;
  unseenHasError: Readonly<Record<string, boolean>>;
  quota: QuotaMeState;
  work: MyWorkState;
  scheduled: readonly ScheduledRun[];
  now: number;
  go: TodayActions;
};

const goalWaitingKey = (status: SessionGoalPayload['status'] | undefined): MittrKey | null => {
  if (status === 'blocked') return 'mittr.today.goal.blocked';
  if (status === 'paused') return 'mittr.today.goal.paused';
  if (status === 'budgetLimited') return 'mittr.today.goal.budgetLimited';
  return null;
};

const sessionsById = (state: TodayState): Map<string, Session> => new Map(state.sessions.map((session) => [session.id, session]));

const titleOf = (session: Session | undefined): string => session?.title.trim() || mittrT('mittr.today.untitled');

const directoryOf = (session: Session | undefined, fallback: string | null): string | null =>
  (session ? resolveGlobalSessionDirectory(session) : null) ?? fallback;

const roots = (state: TodayState): Session[] => state.sessions.filter((session) => !session.parentID);

const permissionText = (action: string, resources: readonly string[]): string => {
  const head = action.trim() || mittrT('mittr.today.kind.approval');
  const resource = resources.find((item) => item.trim());
  return resource ? `${head}: ${resource}` : head;
};

export function waiting(state: TodayState): TodayRow[] {
  const byId = sessionsById(state);
  const rows: TodayRow[] = [];
  for (const [sessionId, pending] of state.blocking) {
    const session = byId.get(sessionId);
    const open = () => state.go.session(sessionId, directoryOf(session, pending.directory));
    for (const request of pending.permissions) {
      rows.push({ id: `approval:${request.id}`, kind: 'approval', title: titleOf(session), detail: permissionText(request.action, request.resources), open });
    }
    for (const request of pending.forms) {
      rows.push({ id: `question:${request.id}`, kind: 'question', title: titleOf(session), detail: request.title.trim() || mittrT('mittr.today.kind.question'), open });
    }
  }
  for (const session of roots(state)) {
    const key = goalWaitingKey(getSessionGoal(session)?.status);
    if (!key) continue;
    rows.push({ id: `goal:${session.id}`, kind: 'goal', title: titleOf(session), detail: mittrT(key), open: () => state.go.session(session.id, directoryOf(session, null)) });
  }
  for (const session of roots(state)) {
    if ((state.unseenCount[session.id] ?? 0) === 0 || state.unseenHasError[session.id]) continue;
    rows.push({ id: `review:${session.id}`, kind: 'review', title: titleOf(session), detail: mittrT('mittr.today.review.detail'), open: () => state.go.session(session.id, directoryOf(session, null)) });
  }
  return rows;
}

const runningDetail = (status: SessionStatus, goal: SessionGoalPayload | null): string => {
  if (goal && goal.status === 'active') {
    return goal.tokenBudget
      ? mittrT('mittr.today.running.goalBudget', { used: formatGoalTokens(goal.tokensUsed), budget: formatGoalTokens(goal.tokenBudget) })
      : mittrT('mittr.today.running.goal', { used: formatGoalTokens(goal.tokensUsed) });
  }
  return mittrT(status.type === 'retry' ? 'mittr.today.running.retry' : 'mittr.today.running.busy');
};

export function running(state: TodayState): TodayRow[] {
  const byId = sessionsById(state);
  const rows: TodayRow[] = [];
  for (const [sessionId, entry] of state.statusById) {
    if (entry.status.type !== 'busy' && entry.status.type !== 'retry') continue;
    const session = byId.get(sessionId);
    if (session?.parentID) continue;
    rows.push({
      id: `running:${sessionId}`,
      kind: 'running',
      title: titleOf(session),
      detail: runningDetail(entry.status, getSessionGoal(session)),
      open: () => state.go.session(sessionId, directoryOf(session, entry.directory)),
    });
  }
  for (const task of state.scheduled) {
    rows.push({ id: `scheduled:${task.projectId}:${task.id}`, kind: 'scheduled', title: task.name, detail: mittrT('mittr.today.running.scheduled'), open: state.go.scheduledTasks });
  }
  return rows;
}

const localDay = (time: number): string => {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const dueDay = (item: WorkItem): string | null => {
  const due = item.due?.trim();
  return due && /^\d{4}-\d{2}-\d{2}/.test(due) ? due.slice(0, 10) : null;
};

const byDue = (left: WorkItem, right: WorkItem): number => {
  const a = dueDay(left);
  const b = dueDay(right);
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
};

export function alerts(state: TodayState): TodayRow[] {
  const rows: TodayRow[] = [];
  if (state.quota.status === 'ok') {
    for (const [alias, status] of state.quota.quota.agentStatus) {
      if (status.state !== 'near' && status.state !== 'out') continue;
      const title = status.state === 'out'
        ? mittrT('mittr.today.alert.quotaOut', { model: alias })
        : mittrT('mittr.today.alert.quotaNear', { model: alias, percent: status.percentLeft ?? Math.floor((status.left / Math.max(1, status.limit)) * 100) });
      rows.push({ id: `quota:${alias}`, kind: 'quota', title, detail: '', open: () => state.go.settings('usage') });
    }
  }
  for (const session of roots(state)) {
    if (!state.unseenHasError[session.id]) continue;
    rows.push({ id: `error:${session.id}`, kind: 'error', title: titleOf(session), detail: mittrT('mittr.today.alert.error'), open: () => state.go.session(session.id, directoryOf(session, null)) });
  }
  if (state.work.status === 'ready') {
    const today = localDay(state.now);
    for (const item of [...state.work.items].sort(byDue)) {
      const due = dueDay(item);
      if (due === null || due > today) continue;
      rows.push({ id: `due:${item.id}`, kind: 'due', title: item.title, detail: mittrT(due < today ? 'mittr.today.alert.overdue' : 'mittr.today.alert.dueToday'), open: () => state.go.work(item) });
    }
  }
  return rows;
}

export function workRows(state: TodayState): TodayRow[] {
  if (state.work.status !== 'ready') return [];
  return [...state.work.items].sort(byDue).map((item) => {
    const due = dueDay(item);
    return {
      id: `work:${item.id}`,
      kind: 'work',
      title: item.title,
      detail: due ? mittrT('mittr.today.work.due', { date: due }) : item.state,
      open: () => state.go.work(item),
    };
  });
}

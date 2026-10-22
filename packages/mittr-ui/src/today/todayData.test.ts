import { describe, expect, test } from 'bun:test';

import type { Session } from '../../../ui/src/lib/opencode/model';
import type { AgentStatus } from '../quota/quotaMeStore';
import type { WorkItem } from '../work/workItems';
import { alerts, running, SCHEDULED_RUN_MAX_MS, scheduledRunsOf, waiting, workRows, type TodayActions, type TodayState } from './todayData';

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  projectID: 'proj_1',
  directory: '/work/app',
  title: `Room ${id}`,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  ...extra,
});

const goal = (status: string) => ({
  openchamber: {
    goal: { id: 'goal_1', objective: 'Ship it', status, tokenBudget: 1000, tokensUsed: 250, turnsUsed: 3, statusReason: '' },
  },
});

const work = (id: string, due: string | null): WorkItem => ({
  id, title: `Card ${id}`, project: 'App', phase: null, state: 'Todo', priority: null, due, estimate: null, url: `https://work.example.test/${id}`, updatedAt: '', source: 'jira', key: id,
});

const calls: string[] = [];
const go: TodayActions = {
  session: (id, directory) => { calls.push(`session:${id}:${directory ?? ''}`); },
  settings: (page) => { calls.push(`settings:${page}`); },
  work: (item) => { calls.push(`work:${item.id}`); },
  scheduledTasks: () => { calls.push('scheduled'); },
};

const EMPTY: TodayState = {
  sessions: [],
  statusById: new Map(),
  blocking: new Map(),
  unseenCount: {},
  unseenHasError: {},
  quota: { status: 'idle' },
  work: { status: 'loading', items: [] },
  scheduled: [],
  now: new Date(2026, 9, 22, 14, 0).getTime(),
  go,
};

const near: AgentStatus = { modelKey: 'mittr-fast', left: 15, limit: 100, resetsAt: '2026-10-26T00:00:00.000Z', state: 'near', percentLeft: 15 };

describe('Today rows', () => {
  test('empty stores give no rows at all', () => {
    expect(waiting(EMPTY)).toEqual([]);
    expect(running(EMPTY)).toEqual([]);
    expect(alerts(EMPTY)).toEqual([]);
  });

  test('a waiting permission is an approval row that opens its room', () => {
    calls.length = 0;
    const rows = waiting({
      ...EMPTY,
      sessions: [session('ses_a')],
      blocking: new Map([['ses_a', { directory: '/work/app', permissions: [{ id: 'per_1', sessionID: 'ses_a', action: 'bash', resources: ['rm -rf dist'] }], forms: [] }]]),
    });
    expect(rows.map(({ kind, title, detail }) => ({ kind, title, detail }))).toEqual([{ kind: 'approval', title: 'Room ses_a', detail: 'bash: rm -rf dist' }]);
    rows[0].open();
    expect(calls).toEqual(['session:ses_a:/work/app']);
  });

  test('a waiting form is a question row', () => {
    const rows = waiting({
      ...EMPTY,
      blocking: new Map([['ses_b', { directory: '/work/app', permissions: [], forms: [{ id: 'form_1', sessionID: 'ses_b', title: 'Which branch?' }] }]]),
    });
    expect(rows.map(({ kind, title, detail }) => ({ kind, title, detail }))).toEqual([{ kind: 'question', title: 'Untitled room', detail: 'Which branch?' }]);
  });

  test('a finished room not opened yet is a review row, and an errored one an alert instead', () => {
    const state = { ...EMPTY, sessions: [session('ses_a'), session('ses_b')], unseenCount: { ses_a: 1, ses_b: 2 }, unseenHasError: { ses_b: true } };
    expect(waiting(state).map(({ id, kind }) => ({ id, kind }))).toEqual([{ id: 'review:ses_a', kind: 'review' }]);
    const errors = alerts(state);
    expect(errors.map(({ kind, title, detail }) => ({ kind, title, detail }))).toEqual([{ kind: 'error', title: 'Room ses_b', detail: 'Ended with an error' }]);
  });

  test('a sub-session is never its own row', () => {
    const state = { ...EMPTY, sessions: [session('ses_child', { parentID: 'ses_a' })], unseenCount: { ses_child: 1 } };
    expect(waiting(state)).toEqual([]);
  });

  test('a blocked, paused or out-of-budget goal is a goal row; an active one is not', () => {
    const state = {
      ...EMPTY,
      sessions: [
        session('ses_blocked', { metadata: goal('blocked') }),
        session('ses_paused', { metadata: goal('paused') }),
        session('ses_budget', { metadata: goal('budgetLimited') }),
        session('ses_active', { metadata: goal('active') }),
      ],
    };
    expect(waiting(state).map(({ kind, detail }) => `${kind}:${detail}`)).toEqual([
      'goal:Goal blocked',
      'goal:Goal paused',
      'goal:Goal out of budget',
    ]);
  });

  test('a busy room is a running row with its goal progress, and a running scheduled task too', () => {
    calls.length = 0;
    const rows = running({
      ...EMPTY,
      sessions: [session('ses_a', { metadata: goal('active') }), session('ses_b')],
      statusById: new Map([
        ['ses_a', { status: { type: 'busy' }, directory: '/work/app' }],
        ['ses_b', { status: { type: 'retry', attempt: 1, message: 'x', next: 2 }, directory: '/work/app' }],
      ]),
      scheduled: [{ id: 'task_1', name: 'Nightly build check', projectId: 'proj_1' }],
    });
    expect(rows.map(({ kind, title, detail }) => `${kind}|${title}|${detail}`)).toEqual([
      'running|Room ses_a|Goal: 250 of 1.0K tokens',
      'running|Room ses_b|Retrying',
      'scheduled|Nightly build check|Scheduled task running',
    ]);
    rows[2].open();
    expect(calls).toEqual(['scheduled']);
  });

  test('a model near its weekly quota is an alert that opens the usage settings', () => {
    calls.length = 0;
    const rows = alerts({ ...EMPTY, quota: { status: 'ok', quota: { agentStatus: new Map([['mittr-fast', near], ['mittr-pro', { ...near, modelKey: 'mittr-pro', state: 'ok' }]]) } } });
    expect(rows.map(({ kind, title }) => `${kind}|${title}`)).toEqual(["quota|mittr-fast: 15% of this week's quota left"]);
    rows[0].open();
    expect(calls).toEqual(['settings:usage']);
  });

  test('a used-up model is an alert too', () => {
    const rows = alerts({ ...EMPTY, quota: { status: 'ok', quota: { agentStatus: new Map([['mittr-fast', { ...near, state: 'out', left: 0 }]]) } } });
    expect(rows.map(({ title }) => title)).toEqual(["mittr-fast: this week's quota is used up"]);
  });

  test('work due today or overdue is an alert; later work is not', () => {
    const rows = alerts({ ...EMPTY, work: { status: 'ready', items: [work('MRKB-1', '2026-10-21'), work('MRKB-2', '2026-10-22'), work('MRKB-3', '2026-10-23'), work('MRKB-4', null)] } });
    expect(rows.map(({ kind, title, detail }) => `${kind}|${title}|${detail}`)).toEqual([
      'due|Card MRKB-1|Overdue',
      'due|Card MRKB-2|Due today',
    ]);
  });

  test('work rows are sorted by due date, undated last, and open through My work', () => {
    calls.length = 0;
    const rows = workRows({ ...EMPTY, work: { status: 'ready', items: [work('MRKB-4', null), work('MRKB-3', '2026-10-23'), work('MRKB-1', '2026-10-21')] } });
    expect(rows.map(({ title }) => title)).toEqual(['Card MRKB-1', 'Card MRKB-3', 'Card MRKB-4']);
    rows[0].open();
    expect(calls).toEqual(['work:MRKB-1']);
  });
});

describe('scheduled runs on Today', () => {
  test('Minor 6: a task counts as running only while its run started within the run time limit', () => {
    const now = 10_000_000;
    const tasks = [
      { id: 'live', name: 'Nightly report', state: { lastStatus: 'running', lastRunAt: now - 60_000 } },
      { id: 'stuck', name: 'Left after a quit', state: { lastStatus: 'running', lastRunAt: now - SCHEDULED_RUN_MAX_MS - 1 } },
      { id: 'undated', name: 'No start time', state: { lastStatus: 'running' } },
      { id: 'done', name: 'Finished', state: { lastStatus: 'success', lastRunAt: now - 1_000 } },
    ];
    expect(scheduledRunsOf('proj_1', tasks, now)).toEqual([{ id: 'live', name: 'Nightly report', projectId: 'proj_1' }]);
    expect(SCHEDULED_RUN_MAX_MS).toBe(30 * 60 * 1000);
  });
});

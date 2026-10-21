import { describe, expect, test } from 'bun:test';

import type { AgentStatus } from '../quota/quotaMeStore';
import { mittrT } from '../strings/mittrT';
import { mittrAvailable, mittrCatalogAliases, planGoWork, runGoWork, startGoWork, type GoWorkDeps, type GoWorkPlan } from './goWork';
import type { WorkItem } from './workItems';

const item = (overrides: Partial<WorkItem> = {}): WorkItem => ({
  id: 'w-1',
  title: 'Fix login',
  project: 'P',
  phase: null,
  state: 'In Progress',
  priority: null,
  due: null,
  estimate: null,
  url: 'https://x.atlassian.net/browse/MRKB-2122',
  updatedAt: '2026-10-20T00:00:00Z',
  source: 'jira',
  key: 'MRKB-2122',
  ...overrides,
});

const PROJECT = { id: 'p-1', path: '/work/app' };
const MITTR = { providerID: 'mittr', modelID: 'a', agentName: 'build', variant: 'high' };

const status = (state: AgentStatus['state'], over: Partial<AgentStatus> = {}): AgentStatus => ({
  modelKey: 'k',
  left: state === 'out' ? 0 : 50,
  limit: 100,
  resetsAt: '2026-10-27T00:00:00+07:00',
  state,
  ...over,
});

type Call = [string, ...unknown[]];

const fakeDeps = (overrides: Partial<GoWorkDeps> = {}) => {
  const calls: Call[] = [];
  const deps: GoWorkDeps = {
    createSession: async (title, directory, selection) => {
      calls.push(['createSession', title, directory, selection]);
      return { id: 'ses_1', directory };
    },
    initialize: (sessionId) => { calls.push(['initialize', sessionId]); },
    sendMessage: async (prompt, selection, sessionId, directory) => {
      calls.push(['sendMessage', prompt, selection, sessionId, directory]);
    },
    closeDialog: () => { calls.push(['closeDialog']); },
    reload: () => { calls.push(['reload']); },
    toast: {
      success: (message) => { calls.push(['toast.success', message]); },
      error: (message, options) => { calls.push(['toast.error', message, options?.description]); },
    },
    ...overrides,
  };
  return { deps, calls, names: () => calls.map(([name]) => name) };
};

const okPlan = (overrides: Partial<Parameters<typeof planGoWork>[0]> = {}): GoWorkPlan => planGoWork({
  item: item(),
  project: PROJECT,
  selection: MITTR,
  available: true,
  listIsForCurrentAccount: true,
  ...overrides,
});

describe('Go work', () => {
  test("a Jira card's prompt carries its key, title and link", () => {
    const plan = okPlan();
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.prompt).toBe('อ่าน Jira issue MRKB-2122 (Fix login) ที่ https://x.atlassian.net/browse/MRKB-2122 แล้วบอกว่าต้องทำอะไร');
    expect(plan.title).toBe('Fix login');
    expect(plan.directory).toBe('/work/app');
    expect(plan.selection).toEqual(MITTR);
  });

  test("a Jira card without a sent key takes the key from its browse link", () => {
    const plan = okPlan({ item: item({ key: null }) });
    expect(plan.ok && plan.prompt).toBe('อ่าน Jira issue MRKB-2122 (Fix login) ที่ https://x.atlassian.net/browse/MRKB-2122 แล้วบอกว่าต้องทำอะไร');
  });

  test("a Plane card's prompt carries its title and link", () => {
    const plane = item({ source: 'plane', key: 'APP-12', title: 'Ship the form', url: 'https://plane.example.test/ws/projects/1/issues/12' });
    const plan = okPlan({ item: plane });
    expect(plan.ok && plan.prompt).toBe('อ่านงาน "Ship the form" ที่ https://plane.example.test/ws/projects/1/issues/12 แล้วบอกว่าต้องทำอะไร');
  });

  test('a card with no link still builds its prompt', () => {
    const card = item({ source: 'plane', key: null });
    Reflect.deleteProperty(card, 'url');
    const plan = okPlan({ item: card });
    expect(plan.ok && plan.prompt).toBe('อ่านงาน "Fix login" ที่  แล้วบอกว่าต้องทำอะไร');
  });

  test('no project, no model and no Mittr model are refused in that order', () => {
    expect(okPlan({ project: null, selection: null, available: false })).toEqual({ ok: false, reason: 'no-project' });
    expect(okPlan({ project: { id: 'p', path: '  ' } })).toEqual({ ok: false, reason: 'no-project' });
    expect(okPlan({ selection: null, available: false })).toEqual({ ok: false, reason: 'no-model' });
    expect(okPlan({ available: false })).toEqual({ ok: false, reason: 'no-mittr-model' });
  });

  test('a list loaded for another account is refused before anything else', () => {
    expect(okPlan({ listIsForCurrentAccount: false, project: null, selection: null, available: false })).toEqual({ ok: false, reason: 'account-changed' });
  });

  test('a list loaded for another account starts no session, says the account changed and reloads the list', async () => {
    const { deps, calls, names } = fakeDeps();
    expect(await runGoWork(okPlan({ listIsForCurrentAccount: false }), deps)).toBe('failed');
    expect(names()).not.toContain('createSession');
    expect(names()).not.toContain('sendMessage');
    expect(calls).toEqual([['toast.error', mittrT('mittr.work.accountChanged'), undefined], ['reload']]);
  });

  test('other refusals do not reload the list', async () => {
    const { deps, names } = fakeDeps();
    await runGoWork(okPlan({ project: null }), deps);
    expect(names()).not.toContain('reload');
  });

  test('no model selected creates no session', async () => {
    const { deps, calls, names } = fakeDeps();
    expect(await runGoWork(okPlan({ selection: null, available: null }), deps)).toBe('failed');
    expect(names()).not.toContain('createSession');
    expect(calls).toEqual([['toast.error', mittrT('mittr.work.error.noModelSelected'), undefined]]);
  });

  test('every Mittr agent used up creates no session', async () => {
    const statuses = new Map([['a', status('out')], ['b', status('out')]]);
    const available = mittrAvailable(MITTR, ['a', 'b'], statuses);
    expect(available).toBe(false);
    const plan = okPlan({ available });
    expect(plan).toEqual({ ok: false, reason: 'no-mittr-model' });
    const { deps, calls, names } = fakeDeps();
    expect(await runGoWork(plan, deps)).toBe('failed');
    expect(names()).not.toContain('createSession');
    expect(calls).toEqual([['toast.error', 'No Mittr model is available to you this week.', undefined]]);
  });

  test('no project creates no session and says to add one', async () => {
    const { deps, calls } = fakeDeps();
    expect(await runGoWork(okPlan({ project: null }), deps)).toBe('failed');
    expect(calls).toEqual([['toast.error', mittrT('mittr.work.projectMenu.empty'), undefined]]);
  });

  test('a used-up agent a backup may answer for still proceeds', () => {
    const statuses = new Map([['a', status('out', { maySubstitute: true })], ['b', status('out')]]);
    expect(mittrAvailable(MITTR, ['a', 'b'], statuses)).toBe(true);
    expect(okPlan({ available: mittrAvailable(MITTR, ['a', 'b'], statuses) }).ok).toBe(true);
  });

  test('one agent with quota left, or with no status, keeps Mittr available', () => {
    expect(mittrAvailable(MITTR, ['a', 'b'], new Map([['a', status('out')], ['b', status('near')]]))).toBe(true);
    expect(mittrAvailable(MITTR, ['a', 'b'], new Map([['a', status('out')]]))).toBe(true);
  });

  test('an unknown quota still starts the work', () => {
    const available = mittrAvailable(MITTR, ['a', 'b'], null);
    expect(available).toBeNull();
    expect(mittrAvailable(MITTR, [], new Map([['a', status('out')]]))).toBeNull();
    expect(okPlan({ available }).ok).toBe(true);
  });

  test('another provider is not held to the Mittr quota', () => {
    const statuses = new Map([['a', status('out')]]);
    expect(mittrAvailable({ ...MITTR, providerID: 'other' }, ['a'], statuses)).toBe(true);
    expect(mittrAvailable(null, ['a'], statuses)).toBe(true);
  });

  test("the catalog aliases are the Mittr provider's model ids", () => {
    const providers = [
      { id: 'other', models: [{ id: 'x' }] },
      { id: 'mittr', models: [{ id: 'a' }, { id: 'b' }] },
    ];
    expect(mittrCatalogAliases(providers)).toEqual(['a', 'b']);
    expect(mittrCatalogAliases([{ id: 'other', models: [{ id: 'x' }] }])).toEqual([]);
  });

  test('the session is created on the selection and opened', async () => {
    const { deps, calls } = fakeDeps();
    const plan = okPlan();
    expect(await runGoWork(plan, deps)).toBe('started');
    if (!plan.ok) return;
    expect(calls).toEqual([
      ['createSession', 'Fix login', '/work/app', MITTR],
      ['initialize', 'ses_1'],
      ['closeDialog'],
      ['sendMessage', plan.prompt, MITTR, 'ses_1', '/work/app'],
      ['toast.success', mittrT('mittr.work.toast.sessionCreated')],
    ]);
  });

  test('the first message goes to the directory the session was created in', async () => {
    const { deps, calls } = fakeDeps({ createSession: async () => ({ id: 'ses_2', directory: '/work/app/sub' }) });
    expect(await runGoWork(okPlan(), deps)).toBe('started');
    expect(calls.find(([name]) => name === 'sendMessage')?.slice(3)).toEqual(['ses_2', '/work/app/sub']);
  });

  test('a session that cannot be created reports start failed and sends nothing', async () => {
    const { deps, calls, names } = fakeDeps({ createSession: async () => null });
    expect(await runGoWork(okPlan(), deps)).toBe('failed');
    expect(names()).toEqual(['toast.error']);
    expect(calls[0][1]).toBe(mittrT('mittr.work.toast.startFailed'));
  });

  test('a create that throws reports start failed with its reason', async () => {
    const { deps, calls } = fakeDeps({ createSession: async () => { throw new Error('engine down'); } });
    expect(await runGoWork(okPlan(), deps)).toBe('failed');
    expect(calls).toEqual([['toast.error', mittrT('mittr.work.toast.startFailed'), 'engine down']]);
  });

  test('a failed send after creation reports start failed', async () => {
    const { deps, calls, names } = fakeDeps({
      sendMessage: async () => { throw new Error('send refused'); },
    });
    expect(await runGoWork(okPlan(), deps)).toBe('failed');
    expect(names()).toEqual(['createSession', 'initialize', 'closeDialog', 'toast.error']);
    expect(calls.at(-1)).toEqual(['toast.error', mittrT('mittr.work.toast.startFailed'), 'send refused']);
  });

  test('a plan that throws leaves Go work usable', async () => {
    const guard = { current: false };
    const starting: Array<string | null> = [];
    const { deps, calls } = fakeDeps();
    const broken = () => { throw new Error('store not ready'); };
    expect(await startGoWork(guard, (id) => starting.push(id), 'w-1', broken, deps)).toBe('failed');
    expect(guard.current).toBe(false);
    expect(starting).toEqual(['w-1', null]);
    expect(calls).toEqual([['toast.error', mittrT('mittr.work.toast.startFailed'), 'store not ready']]);
    expect(await startGoWork(guard, (id) => starting.push(id), 'w-1', () => okPlan(), deps)).toBe('started');
    expect(guard.current).toBe(false);
    expect(starting).toEqual(['w-1', null, 'w-1', null]);
  });

  test('a second Go work while one runs starts nothing', async () => {
    const guard = { current: true };
    const starting: Array<string | null> = [];
    const { deps, calls } = fakeDeps();
    let planned = false;
    const plan = () => { planned = true; return okPlan(); };
    expect(await startGoWork(guard, (id) => starting.push(id), 'w-1', plan, deps)).toBe('busy');
    expect(planned).toBe(false);
    expect(starting).toEqual([]);
    expect(calls).toEqual([]);
    expect(guard.current).toBe(true);
  });
});

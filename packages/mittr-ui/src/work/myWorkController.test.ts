import { describe, expect, test } from 'bun:test';

import { createMyWorkController, type MyWorkState } from './myWorkController';
import type { MyWorkReply } from './workApi';
import type { WorkItem } from './workItems';

const item = (id: string): WorkItem => ({
  id,
  title: id,
  project: 'P',
  phase: null,
  state: 'Todo',
  priority: null,
  due: null,
  estimate: null,
  url: `https://example.test/${id}`,
  updatedAt: '2026-10-20T00:00:00Z',
  source: 'jira',
});

type Pending = { resolve: (reply: MyWorkReply) => void; reject: (error: Error) => void };

const setup = (account: { current: string | null } = { current: 'u-b' }) => {
  const pending: Pending[] = [];
  const accountListeners = new Set<() => void>();
  const seen: MyWorkState[] = [];
  const controller = createMyWorkController({
    fetchWork: () => new Promise<MyWorkReply>((resolve, reject) => { pending.push({ resolve, reject }); }),
    currentUserId: () => account.current,
    listenAccountChanged: (onChange) => {
      accountListeners.add(onChange);
      return () => { accountListeners.delete(onChange); };
    },
  });
  controller.subscribe(() => { seen.push(controller.state()); });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const accountChanged = () => { for (const listener of [...accountListeners]) listener(); };
  return { controller, pending, seen, settle, accountChanged, accountListeners, account };
};

describe('My work controller', () => {
  test('a reply for another account is dropped and the list reloads', async () => {
    const { controller, pending, seen, settle } = setup({ current: 'u-b' });
    void controller.refresh();
    pending[0].resolve({ configured: true, items: [item('a-secret')], userId: 'u-a' });
    await settle();
    expect(pending).toHaveLength(2);
    pending[1].resolve({ configured: true, items: [item('b-own')], userId: 'u-b' });
    await settle();
    expect(seen.some((state) => state.items.some((shown) => shown.id === 'a-secret'))).toBe(false);
    expect(controller.state()).toEqual({ status: 'ready', items: [item('b-own')] });
  });

  test('a second reply for another account keeps the list loading until the account changes', async () => {
    const { controller, pending, seen, settle, accountChanged } = setup({ current: 'u-b' });
    void controller.refresh();
    pending[0].resolve({ configured: true, items: [item('a-1')], userId: 'u-a' });
    await settle();
    pending[1].resolve({ configured: true, items: [item('a-2')], userId: 'u-a' });
    await settle();
    expect(pending).toHaveLength(2);
    expect(controller.state()).toEqual({ status: 'loading', items: [] });
    accountChanged();
    expect(pending).toHaveLength(3);
    pending[2].resolve({ configured: true, items: [item('b-1')], userId: 'u-b' });
    await settle();
    expect(controller.state().items.map((shown) => shown.id)).toEqual(['b-1']);
    expect(seen.some((state) => state.items.some((shown) => shown.id.startsWith('a-')))).toBe(false);
  });

  test('Refresh after a failed retry may retry a mismatch again', async () => {
    const { controller, pending, seen, settle } = setup({ current: 'u-b' });
    void controller.refresh();
    pending[0].resolve({ configured: true, items: [item('a-1')], userId: 'u-a' });
    await settle();
    pending[1].reject(new Error('Mittr platform is unavailable'));
    await settle();
    expect(controller.state().status).toBe('error');
    void controller.refresh();
    expect(pending).toHaveLength(3);
    pending[2].resolve({ configured: true, items: [item('a-2')], userId: 'u-a' });
    await settle();
    expect(pending).toHaveLength(4);
    pending[3].resolve({ configured: true, items: [item('b-1')], userId: 'u-b' });
    await settle();
    expect(controller.state()).toEqual({ status: 'ready', items: [item('b-1')] });
    expect(seen.some((state) => state.items.some((shown) => shown.id.startsWith('a-')))).toBe(false);
  });

  test('not configured shows the not-connected state', async () => {
    const { controller, pending, settle } = setup();
    void controller.refresh();
    pending[0].resolve({ configured: false, items: [], userId: null });
    await settle();
    expect(controller.state()).toEqual({ status: 'not-connected', items: [] });
  });

  test('an account change reloads', async () => {
    const { controller, pending, settle, accountChanged } = setup();
    void controller.refresh();
    pending[0].resolve({ configured: true, items: [item('b-1')], userId: 'u-b' });
    await settle();
    expect(controller.state().status).toBe('ready');
    accountChanged();
    expect(pending).toHaveLength(2);
    expect(controller.state()).toEqual({ status: 'loading', items: [] });
  });

  test('the list is for the current account only while it is ready and loaded for that account', async () => {
    const { controller, pending, settle, account } = setup({ current: 'u-a' });
    expect(controller.listIsForCurrentAccount()).toBe(false);
    void controller.refresh();
    expect(controller.listIsForCurrentAccount()).toBe(false);
    pending[0].resolve({ configured: true, items: [item('a-1')], userId: 'u-a' });
    await settle();
    expect(controller.listIsForCurrentAccount()).toBe(true);
    account.current = 'u-b';
    expect(controller.state().items.map((shown) => shown.id)).toEqual(['a-1']);
    expect(controller.listIsForCurrentAccount()).toBe(false);
    void controller.refresh();
    pending[1].resolve({ configured: false, items: [], userId: null });
    await settle();
    expect(controller.listIsForCurrentAccount()).toBe(false);
  });

  test('a slow first reply never overwrites a newer one', async () => {
    const { controller, pending, settle } = setup();
    void controller.refresh();
    void controller.refresh();
    pending[1].resolve({ configured: true, items: [item('new')], userId: 'u-b' });
    await settle();
    pending[0].resolve({ configured: true, items: [item('old')], userId: 'u-b' });
    await settle();
    expect(controller.state().items.map((shown) => shown.id)).toEqual(['new']);
    expect(pending).toHaveLength(2);
  });

  test('a failed read shows the error with its text, and a late failure never replaces newer items', async () => {
    const { controller, pending, settle } = setup();
    void controller.refresh();
    pending[0].reject(new Error('Mittr platform is unavailable'));
    await settle();
    expect(controller.state()).toEqual({ status: 'error', items: [], error: 'Mittr platform is unavailable' });
    void controller.refresh();
    void controller.refresh();
    pending[2].resolve({ configured: true, items: [item('kept')], userId: 'u-b' });
    await settle();
    pending[1].reject(new Error('late'));
    await settle();
    expect(controller.state().items.map((shown) => shown.id)).toEqual(['kept']);
  });

  test('after dispose nothing is heard and no reply sets state', async () => {
    const { controller, pending, seen, settle, accountChanged, accountListeners } = setup();
    void controller.refresh();
    controller.dispose();
    expect(accountListeners.size).toBe(0);
    const heard = seen.length;
    pending[0].resolve({ configured: true, items: [item('b-1')], userId: 'u-b' });
    await settle();
    accountChanged();
    expect(seen.length).toBe(heard);
    expect(pending).toHaveLength(1);
  });
});

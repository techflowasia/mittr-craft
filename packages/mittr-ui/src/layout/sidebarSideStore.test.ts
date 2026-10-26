import { describe, expect, test } from 'bun:test';

import type { SidebarSide, SidebarSideApi, SidebarSideSettings } from './sidebarSideApi';
import { createSidebarSideStore } from './sidebarSideStore';

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};

const fakeApi = (initial: SidebarSideSettings = { sidebarSide: 'right', canChange: true }) => {
  const saves: SidebarSide[] = [];
  let loads = 0;
  let failSave: Error | null = null;
  const api: SidebarSideApi = {
    load: async () => { loads += 1; return initial; },
    save: async (side) => {
      saves.push(side);
      if (failSave) throw failSave;
      return { sidebarSide: side, canChange: true };
    },
  };
  return { api, saves, loads: () => loads, failNextSave: (error: Error) => { failSave = error; } };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('sidebar side store', () => {
  test('the side is left until the stored side arrives, which loads on the first subscriber', async () => {
    const fake = fakeApi();
    const store = createSidebarSideStore({ api: fake.api });
    expect(store.get()).toBe('left');
    expect(fake.loads()).toBe(0);
    let notified = 0;
    const stop = store.subscribe(() => { notified += 1; });
    store.subscribe(() => {});
    await settle();
    expect(fake.loads()).toBe(1);
    expect(store.get()).toBe('right');
    expect(store.state()).toEqual({ status: 'ready', sidebarSide: 'right', canChange: true, saving: false });
    expect(notified).toBeGreaterThan(0);
    stop();
  });

  test('a load that fails keeps the left edge and reports the error', async () => {
    const store = createSidebarSideStore({ api: { load: async () => { throw new Error('Could not load'); }, save: async () => ({ sidebarSide: 'left', canChange: true }) } });
    await store.load();
    expect(store.get()).toBe('left');
    expect(store.state()).toEqual({ status: 'error', error: 'Could not load' });
  });

  test('choosing a side moves the sidebar at once and keeps what was stored', async () => {
    const fake = fakeApi({ sidebarSide: 'left', canChange: true });
    const store = createSidebarSideStore({ api: fake.api });
    await store.load();
    const done = store.choose('right');
    expect(store.get()).toBe('right');
    expect(await done).toBeNull();
    expect(fake.saves).toEqual(['right']);
    expect(store.state()).toEqual({ status: 'ready', sidebarSide: 'right', canChange: true, saving: false });
  });

  test('a save that fails puts the sidebar back and says why', async () => {
    const fake = fakeApi({ sidebarSide: 'left', canChange: true });
    const store = createSidebarSideStore({ api: fake.api });
    await store.load();
    fake.failNextSave(new Error('Cannot store the sidebar setting on this machine'));
    expect(await store.choose('right')).toBe('Cannot store the sidebar setting on this machine');
    expect(store.get()).toBe('left');
  });

  test('nothing changes where this Mac cannot change it, or while a save runs', async () => {
    const remote = fakeApi({ sidebarSide: 'right', canChange: false });
    const locked = createSidebarSideStore({ api: remote.api });
    await locked.load();
    expect(await locked.choose('left')).toBeNull();
    expect(remote.saves).toEqual([]);
    expect(locked.get()).toBe('right');

    const slow = deferred<SidebarSideSettings>();
    const store = createSidebarSideStore({ api: { load: async () => ({ sidebarSide: 'left', canChange: true }), save: () => slow.promise } });
    await store.load();
    const first = store.choose('right');
    expect(await store.choose('left')).toBeNull();
    slow.resolve({ sidebarSide: 'right', canChange: true });
    expect(await first).toBeNull();
    expect(store.get()).toBe('right');
  });
});

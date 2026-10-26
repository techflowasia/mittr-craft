import { describe, expect, test } from 'bun:test';
import { create } from 'zustand';

import { keepMittrInUsageDropdown, storedAddedMark, type UsageDropdownDeps } from './usageDropdown';

type Saved = { ids: string[] | null; readFails: boolean };

const quotaStore = (saved: Saved, initial: string[]) => create<{ dropdownProviderIds: string[]; loadSettings: () => Promise<void> }>()((set) => ({
  dropdownProviderIds: initial,
  loadSettings: async () => {
    if (saved.readFails) return;
    set({ dropdownProviderIds: saved.ids ? [...saved.ids] : ['mittr', ...initial] });
  },
}));

const memoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
};

const depsFor = (saved: Saved, storage: Storage, saveOk = true) => {
  const writes: string[][] = [];
  const deps: UsageDropdownDeps = {
    persist: async (ids) => {
      writes.push(ids);
      if (saveOk) saved.ids = ids;
    },
    ...storedAddedMark(() => storage),
  };
  return { deps, writes };
};

describe('Mittr in the usage dropdown', () => {
  test('a list saved before Mittr existed gets Mittr once, and keeps every other choice', async () => {
    const saved: Saved = { ids: ['codex', 'google'], readFails: false };
    const store = quotaStore(saved, ['codex', 'google', 'openrouter']);
    const { deps, writes } = depsFor(saved, memoryStorage());
    keepMittrInUsageDropdown(store, 'mittr', deps);
    await store.getState().loadSettings();
    expect(store.getState().dropdownProviderIds).toEqual(['codex', 'google', 'mittr']);
    expect(writes).toEqual([['codex', 'google', 'mittr']]);
    await store.getState().loadSettings();
    expect(store.getState().dropdownProviderIds).toEqual(['codex', 'google', 'mittr']);
    expect(writes).toHaveLength(1);
  });

  test('a person who hides Mittr afterwards keeps it hidden, in this run and the next', async () => {
    const saved: Saved = { ids: ['codex'], readFails: false };
    const storage = memoryStorage();
    const store = quotaStore(saved, ['codex']);
    keepMittrInUsageDropdown(store, 'mittr', depsFor(saved, storage).deps);
    await store.getState().loadSettings();
    saved.ids = ['codex'];
    store.setState({ dropdownProviderIds: ['codex'] });
    await store.getState().loadSettings();
    expect(store.getState().dropdownProviderIds).toEqual(['codex']);

    const nextRun = quotaStore(saved, ['codex']);
    const { deps, writes } = depsFor(saved, storage);
    keepMittrInUsageDropdown(nextRun, 'mittr', deps);
    await nextRun.getState().loadSettings();
    expect(nextRun.getState().dropdownProviderIds).toEqual(['codex']);
    expect(writes).toEqual([]);
  });

  test('a list that already has Mittr is left alone', async () => {
    const saved: Saved = { ids: null, readFails: false };
    const store = quotaStore(saved, ['codex']);
    const { deps, writes } = depsFor(saved, memoryStorage());
    keepMittrInUsageDropdown(store, 'mittr', deps);
    await store.getState().loadSettings();
    expect(store.getState().dropdownProviderIds).toEqual(['mittr', 'codex']);
    expect(writes).toEqual([]);
    expect(deps.wasAdded()).toBe(true);
  });

  test('the list shows Mittr before the settings are read, and a failed read claims nothing', async () => {
    const saved: Saved = { ids: ['codex'], readFails: true };
    const store = quotaStore(saved, ['codex', 'google']);
    const { deps, writes } = depsFor(saved, memoryStorage());
    keepMittrInUsageDropdown(store, 'mittr', deps);
    expect(store.getState().dropdownProviderIds).toEqual(['codex', 'google', 'mittr']);
    await store.getState().loadSettings();
    expect(writes).toEqual([]);
    expect(deps.wasAdded()).toBe(false);
    saved.readFails = false;
    await store.getState().loadSettings();
    expect(store.getState().dropdownProviderIds).toEqual(['codex', 'mittr']);
  });

  test('a failed first save, then the person hiding Mittr, never brings it back', async () => {
    const saved: Saved = { ids: ['codex'], readFails: false };
    const store = quotaStore(saved, ['codex']);
    const { deps, writes } = depsFor(saved, memoryStorage(), false);
    keepMittrInUsageDropdown(store, 'mittr', deps);
    await store.getState().loadSettings();
    expect(store.getState().dropdownProviderIds).toEqual(['codex', 'mittr']);
    expect(writes).toEqual([['codex', 'mittr']]);
    store.setState({ dropdownProviderIds: ['codex'] });
    await store.getState().loadSettings();
    expect(store.getState().dropdownProviderIds).toEqual(['codex']);
    expect(writes).toHaveLength(1);
    expect(deps.wasAdded()).toBe(true);
  });

  test('without browser storage Mittr is still added only once per run', () => {
    const mark = storedAddedMark(() => {
      throw new Error('storage blocked');
    });
    expect(mark.wasAdded()).toBe(false);
    mark.markAdded();
    expect(mark.wasAdded()).toBe(true);
    expect(storedAddedMark(() => undefined).wasAdded()).toBe(false);
  });
});

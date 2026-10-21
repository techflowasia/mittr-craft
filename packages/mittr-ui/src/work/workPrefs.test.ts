import { describe, expect, test } from 'bun:test';

import { createWorkPrefs } from './workPrefs';

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
};

const brokenStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('my work preferences', () => {
  test('the source filter defaults to all and is remembered', () => {
    const storage = memoryStorage();
    const prefs = createWorkPrefs(storage);
    expect(prefs.sourceFilter()).toBe('all');
    prefs.setSourceFilter('plane:mittr');
    expect(prefs.sourceFilter()).toBe('plane:mittr');
    expect(storage.data.get('mittrcraft.myWork.source')).toBe('plane:mittr');
    expect(createWorkPrefs(storage).sourceFilter()).toBe('plane:mittr');
  });

  test('a group with no saved choice follows its rank', () => {
    const prefs = createWorkPrefs(memoryStorage());
    expect([0, 1, 2, 3, 4].map((rank) => prefs.groupOpen('jira:x', rank))).toEqual([true, true, true, false, false]);
  });

  test('a folded group stays folded', () => {
    const storage = memoryStorage();
    const prefs = createWorkPrefs(storage);
    prefs.setGroupOpen('jira:Done', false);
    expect(prefs.groupOpen('jira:Done', 0)).toBe(false);
    expect(storage.data.get('mittrcraft.myWork.groupOpen.jira:Done')).toBe('0');
    prefs.setGroupOpen('jira:Done', true);
    expect(prefs.groupOpen('jira:Done', 3)).toBe(true);
    expect(storage.data.get('mittrcraft.myWork.groupOpen.jira:Done')).toBe('1');
  });

  test('an unreadable saved value falls back to the rank', () => {
    const storage = memoryStorage();
    storage.data.set('mittrcraft.myWork.groupOpen.jira:Done', 'maybe');
    expect(createWorkPrefs(storage).groupOpen('jira:Done', 3)).toBe(false);
  });

  test('storage that throws falls back to defaults', () => {
    const prefs = createWorkPrefs(brokenStorage);
    expect(prefs.sourceFilter()).toBe('all');
    expect(prefs.groupOpen('jira:Done', 3)).toBe(false);
    expect(prefs.groupOpen('jira:Todo', 1)).toBe(true);
    prefs.setSourceFilter('jira');
    prefs.setGroupOpen('jira:Done', true);
  });

  test('no storage falls back to defaults', () => {
    const prefs = createWorkPrefs(null);
    expect(prefs.sourceFilter()).toBe('all');
    expect(prefs.groupOpen('jira:Done', 3)).toBe(false);
    prefs.setSourceFilter('plane');
    prefs.setGroupOpen('jira:Done', true);
  });
});

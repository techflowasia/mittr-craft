import { describe, expect, test } from 'bun:test';

import { applyRecentSectionDefault, RECENT_DEFAULT_KEY } from './recentSectionDefault';

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
};

describe('the recent section is on at first start', () => {
  test('a first start turns the recent section on once', () => {
    const storage = memoryStorage();
    const turnedOn: boolean[] = [];
    applyRecentSectionDefault({ storage, shown: false, show: () => { turnedOn.push(true); } });
    expect(turnedOn).toEqual([true]);
    expect(storage.getItem(RECENT_DEFAULT_KEY)).toBe('1');
  });

  test('after that, a person who turned it off keeps it off', () => {
    const storage = memoryStorage();
    applyRecentSectionDefault({ storage, shown: false, show: () => {} });
    const turnedOn: boolean[] = [];
    applyRecentSectionDefault({ storage, shown: false, show: () => { turnedOn.push(true); } });
    expect(turnedOn).toEqual([]);
  });

  test('a section already shown is left alone but the start is still counted', () => {
    const storage = memoryStorage();
    const turnedOn: boolean[] = [];
    applyRecentSectionDefault({ storage, shown: true, show: () => { turnedOn.push(true); } });
    expect(turnedOn).toEqual([]);
    expect(storage.getItem(RECENT_DEFAULT_KEY)).toBe('1');
  });

  test('storage that cannot be read changes nothing', () => {
    const turnedOn: boolean[] = [];
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    applyRecentSectionDefault({ storage: broken, shown: false, show: () => { turnedOn.push(true); } });
    expect(turnedOn).toEqual([]);
  });
});

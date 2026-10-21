import { groupStartsOpen, type LaneFilter } from './workItems';

const SOURCE_FILTER_STORAGE_KEY = 'mittrcraft.myWork.source';
const GROUP_OPEN_STORAGE_PREFIX = 'mittrcraft.myWork.groupOpen.';

type WorkStorage = Pick<Storage, 'getItem' | 'setItem'>;

export type WorkPrefs = {
  sourceFilter(): LaneFilter;
  setSourceFilter(value: LaneFilter): void;
  groupOpen(key: string, rank: number): boolean;
  setGroupOpen(key: string, open: boolean): void;
};

export const createWorkPrefs = (storage: WorkStorage | null): WorkPrefs => {
  const read = (key: string): string | null => {
    try {
      return storage ? storage.getItem(key) : null;
    } catch {
      return null;
    }
  };

  const write = (key: string, value: string): void => {
    try {
      storage?.setItem(key, value);
    } catch {
      return;
    }
  };

  return {
    sourceFilter: () => read(SOURCE_FILTER_STORAGE_KEY) || 'all',
    setSourceFilter: (value) => write(SOURCE_FILTER_STORAGE_KEY, value),
    groupOpen: (key, rank) => {
      const stored = read(GROUP_OPEN_STORAGE_PREFIX + key);
      if (stored === '1') return true;
      if (stored === '0') return false;
      return groupStartsOpen(rank);
    },
    setGroupOpen: (key, open) => write(GROUP_OPEN_STORAGE_PREFIX + key, open ? '1' : '0'),
  };
};

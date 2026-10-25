import { mittrT } from '../strings/mittrT';
import type { SidebarSide, SidebarSideApi } from './sidebarSideApi';

export type SidebarSideState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; sidebarSide: SidebarSide; canChange: boolean; saving: boolean };

export type SidebarSideStore = {
  get(): SidebarSide;
  state(): SidebarSideState;
  subscribe(fn: () => void): () => void;
  load(): Promise<void>;
  choose(side: SidebarSide): Promise<string | null>;
};

export const SIDEBAR_SIDE_LOADING: SidebarSideState = { status: 'loading' };

const messageOf = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback);

export function createSidebarSideStore({ api }: { api: SidebarSideApi }): SidebarSideStore {
  let current: SidebarSideState = SIDEBAR_SIDE_LOADING;
  let generation = 0;
  let started = false;
  const listeners = new Set<() => void>();

  const set = (next: SidebarSideState): void => {
    current = next;
    for (const listener of [...listeners]) listener();
  };

  const load = async (): Promise<void> => {
    started = true;
    generation += 1;
    const request = generation;
    if (current.status === 'error') set(SIDEBAR_SIDE_LOADING);
    try {
      const settings = await api.load();
      if (request === generation) set({ status: 'ready', sidebarSide: settings.sidebarSide, canChange: settings.canChange, saving: false });
    } catch (error) {
      if (request === generation) set({ status: 'error', error: messageOf(error, mittrT('mittr.sidebarSide.errors.loadFailed')) });
    }
  };

  const choose = async (side: SidebarSide): Promise<string | null> => {
    if (current.status !== 'ready' || !current.canChange || current.saving || current.sidebarSide === side) return null;
    const before = current;
    generation += 1;
    const request = generation;
    set({ ...before, sidebarSide: side, saving: true });
    try {
      const stored = await api.save(side);
      if (request === generation) set({ status: 'ready', sidebarSide: stored.sidebarSide, canChange: stored.canChange, saving: false });
      return null;
    } catch (error) {
      if (request === generation) set({ ...before, saving: false });
      return messageOf(error, mittrT('mittr.sidebarSide.errors.saveFailed'));
    }
  };

  return {
    get: () => (current.status === 'ready' ? current.sidebarSide : 'left'),
    state: () => current,
    subscribe: (fn) => {
      listeners.add(fn);
      if (!started) void load();
      return () => { listeners.delete(fn); };
    },
    load,
    choose,
  };
}

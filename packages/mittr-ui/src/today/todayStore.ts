import React from 'react';

import { getRuntimeKey } from '../../../ui/src/lib/runtime-switch';
import { useUIStore } from '../../../ui/src/stores/useUIStore';
import { readLastActiveSession } from '../../../ui/src/sync/last-session-cache';
import { useSessionUIStore } from '../../../ui/src/sync/session-ui-store';

export type TodaySelection = {
  currentSessionId: string | null;
  newSessionDraft: { open: boolean; draftId: number };
};

export type TodayPages = {
  isScheduledTasksDialogOpen: boolean;
  isArchivePageOpen: boolean;
  isUsageStatsPageOpen: boolean;
  worktreesPageProjectId: string | null;
  spacesPageProjectId: string | null;
  runOverviewKey: string | null;
  openGuestPageId: string | null;
};

type Subscribe<T> = (listener: (state: T, prev: T) => void) => () => void;

export type TodayStoreDeps = {
  subscribeSelection: Subscribe<TodaySelection>;
  subscribePages: Subscribe<TodayPages>;
  restoreCandidate: () => string | null;
  closeMainSurfaces: () => void;
  listenSessionRowClicks: (onClick: () => void) => () => void;
};

export type TodayStore = {
  open(): boolean;
  show(): void;
  hide(): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
};

const pageOpen = (pages: TodayPages): boolean =>
  pages.isScheduledTasksDialogOpen
  || pages.isArchivePageOpen
  || pages.isUsageStatsPageOpen
  || pages.worktreesPageProjectId !== null
  || pages.spacesPageProjectId !== null
  || pages.runOverviewKey !== null
  || pages.openGuestPageId !== null;

export function createTodayStore(deps: TodayStoreDeps): TodayStore {
  let isOpen = true;
  let restorePending = deps.restoreCandidate();
  const listeners = new Set<() => void>();

  const set = (next: boolean): void => {
    if (next === isOpen) return;
    isOpen = next;
    for (const listener of [...listeners]) listener();
  };

  const onSelection = (state: TodaySelection, prev: TodaySelection): void => {
    const selected = state.currentSessionId !== null && state.currentSessionId !== prev.currentSessionId;
    if (selected) {
      const restored = prev.currentSessionId === null && restorePending !== null && state.currentSessionId === restorePending;
      restorePending = null;
      if (!restored) set(false);
      return;
    }
    const draftOpened = state.newSessionDraft.open && state.newSessionDraft.draftId !== prev.newSessionDraft.draftId;
    const automaticFirstDraft = prev.currentSessionId === null && !prev.newSessionDraft.open;
    if (draftOpened && !automaticFirstDraft) set(false);
  };

  const onPages = (state: TodayPages, prev: TodayPages): void => {
    if (pageOpen(state) && !pageOpen(prev)) set(false);
  };

  const stops = [
    deps.subscribeSelection(onSelection),
    deps.subscribePages(onPages),
    deps.listenSessionRowClicks(() => set(false)),
  ];

  return {
    open: () => isOpen,
    show: () => {
      deps.closeMainSurfaces();
      set(true);
    },
    hide: () => set(false),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose: () => {
      for (const stop of stops) stop();
      listeners.clear();
    },
  };
}

const listenSessionRowClicks = (onClick: () => void): (() => void) => {
  if (!('document' in globalThis)) return () => {};
  const handler = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest('[data-session-row]')) onClick();
  };
  document.addEventListener('click', handler, true);
  return () => document.removeEventListener('click', handler, true);
};

let shared: TodayStore | null = null;

export function todayStore(): TodayStore {
  shared ??= createTodayStore({
    subscribeSelection: (listener) => useSessionUIStore.subscribe(listener),
    subscribePages: (listener) => useUIStore.subscribe(listener),
    restoreCandidate: () => readLastActiveSession(getRuntimeKey())?.sessionId ?? null,
    closeMainSurfaces: () => useUIStore.getState().closeMainSurfaces(),
    listenSessionRowClicks,
  });
  return shared;
}

export type Today = { open: boolean; show(): void; hide(): void };

export function useToday(): Today {
  const store = todayStore();
  const open = React.useSyncExternalStore(store.subscribe, store.open, store.open);
  return React.useMemo(() => ({ open, show: store.show, hide: store.hide }), [open, store]);
}

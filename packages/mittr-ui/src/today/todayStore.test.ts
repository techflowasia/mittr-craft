import { describe, expect, test } from 'bun:test';

import { createTodayStore, type TodayPages, type TodaySelection } from './todayStore';

type Listener<T> = (state: T, prev: T) => void;

const feed = <T>(initial: T) => {
  let current = initial;
  const listeners = new Set<Listener<T>>();
  return {
    subscribe: (listener: Listener<T>) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set: (patch: Partial<T>) => {
      const prev = current;
      current = { ...current, ...patch };
      for (const listener of listeners) listener(current, prev);
    },
    count: () => listeners.size,
  };
};

const NO_SELECTION: TodaySelection = { currentSessionId: null, newSessionDraft: { open: false, draftId: 0 } };
const NO_PAGES: TodayPages = {
  isScheduledTasksDialogOpen: false,
  isArchivePageOpen: false,
  isUsageStatsPageOpen: false,
  worktreesPageProjectId: null,
  spacesPageProjectId: null,
  runOverviewKey: null,
  openGuestPageId: null,
};

const setup = (restoreCandidate: string | null = null, startedOn: TodaySelection = NO_SELECTION) => {
  const selection = feed(startedOn);
  const pages = feed(NO_PAGES);
  let rowClick: () => void = () => {};
  let surfacesClosed = 0;
  const store = createTodayStore({
    subscribeSelection: selection.subscribe,
    subscribePages: pages.subscribe,
    restoreCandidate: () => restoreCandidate,
    currentSelection: () => startedOn,
    closeMainSurfaces: () => { surfacesClosed += 1; },
    listenSessionRowClicks: (onClick) => {
      rowClick = onClick;
      return () => { rowClick = () => {}; };
    },
  });
  return { store, selection, pages, clickRow: () => rowClick(), surfacesClosed: () => surfacesClosed };
};

describe('Today open state', () => {
  test('Today is open after start', () => {
    expect(setup().store.open()).toBe(true);
  });

  test('the session restored at start opens underneath and Today stays on top', () => {
    const { store, selection } = setup('ses_last');
    selection.set({ currentSessionId: 'ses_last' });
    expect(store.open()).toBe(true);
  });

  test('the automatic first draft at start keeps Today open', () => {
    const { store, selection } = setup();
    selection.set({ newSessionDraft: { open: true, draftId: 1 } });
    expect(store.open()).toBe(true);
  });

  test('selecting a different session after start closes Today', () => {
    const { store, selection } = setup('ses_last');
    selection.set({ currentSessionId: 'ses_last' });
    selection.set({ currentSessionId: 'ses_other' });
    expect(store.open()).toBe(false);
  });

  test('a first selection that is not the restored session closes Today', () => {
    const { store, selection } = setup('ses_last');
    selection.set({ currentSessionId: 'ses_clicked' });
    expect(store.open()).toBe(false);
  });

  test('clicking a session row closes Today, even the row of the session already underneath', () => {
    const { store, selection, clickRow } = setup('ses_last');
    selection.set({ currentSessionId: 'ses_last' });
    clickRow();
    expect(store.open()).toBe(false);
  });

  test('a draft the person opens closes Today', () => {
    const { store, selection } = setup();
    selection.set({ currentSessionId: 'ses_last' });
    store.show();
    selection.set({ newSessionDraft: { open: true, draftId: 2 } });
    expect(store.open()).toBe(false);
  });

  test('a new draft over an open draft closes Today, a change to the same draft does not', () => {
    const { store, selection } = setup();
    selection.set({ newSessionDraft: { open: true, draftId: 1 } });
    selection.set({ newSessionDraft: { open: true, draftId: 1 } });
    expect(store.open()).toBe(true);
    selection.set({ newSessionDraft: { open: true, draftId: 2 } });
    expect(store.open()).toBe(false);
  });

  for (const [flag, value] of [
    ['isUsageStatsPageOpen', true],
    ['isArchivePageOpen', true],
    ['isScheduledTasksDialogOpen', true],
    ['worktreesPageProjectId', 'proj_1'],
    ['spacesPageProjectId', 'proj_1'],
    ['runOverviewKey', 'run_1'],
    ['openGuestPageId', 'guest_1'],
  ] as const) {
    test(`opening an upstream page (${flag}) closes Today`, () => {
      const { store, pages } = setup();
      pages.set({ [flag]: value });
      expect(store.open()).toBe(false);
    });
  }

  test('show() reopens Today and closes the page under it', () => {
    const { store, pages, surfacesClosed } = setup();
    pages.set({ isArchivePageOpen: true });
    store.show();
    expect(store.open()).toBe(true);
    expect(surfacesClosed()).toBe(1);
  });

  test('hide() closes Today and subscribers hear each change once', () => {
    const { store } = setup();
    let heard = 0;
    const stop = store.subscribe(() => { heard += 1; });
    store.hide();
    store.hide();
    store.show();
    stop();
    store.hide();
    expect(heard).toBe(2);
    expect(store.open()).toBe(false);
  });

  test('dispose stops listening', () => {
    const { store, selection, pages } = setup();
    store.dispose();
    expect(selection.count()).toBe(0);
    expect(pages.count()).toBe(0);
  });
});

describe('Today after start', () => {
  test('Minor 9: only the very first automatic draft keeps Today open; a later New session from nothing closes it', () => {
    const { store, selection } = setup();
    selection.set({ newSessionDraft: { open: true, draftId: 1 } });
    expect(store.open()).toBe(true);
    selection.set({ newSessionDraft: { open: false, draftId: 1 } });
    expect(store.open()).toBe(true);
    selection.set({ newSessionDraft: { open: true, draftId: 2 } });
    expect(store.open()).toBe(false);
  });

  test('Minor 9: a change elsewhere in the session store does not use up the first-draft exemption', () => {
    const { store, selection } = setup();
    selection.set({});
    selection.set({ newSessionDraft: { open: true, draftId: 1 } });
    expect(store.open()).toBe(true);
  });

  test('Minor 9: a restore that happened before Today started is not waited for again', () => {
    const { store, selection } = setup('ses_last', { currentSessionId: 'ses_last', newSessionDraft: { open: false, draftId: 0 } });
    expect(store.open()).toBe(true);
    selection.set({ currentSessionId: null });
    selection.set({ currentSessionId: 'ses_last' });
    expect(store.open()).toBe(false);
  });
});

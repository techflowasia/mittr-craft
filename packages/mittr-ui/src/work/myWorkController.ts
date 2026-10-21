import { mittrT } from '../strings/mittrT';
import type { MyWorkReply } from './workApi';
import type { WorkItem } from './workItems';

export type MyWorkState = {
  status: 'loading' | 'not-connected' | 'error' | 'ready';
  items: WorkItem[];
  error?: string;
};

export type MyWorkControllerDeps = {
  fetchWork: () => Promise<MyWorkReply>;
  currentUserId: () => string | null;
  listenAccountChanged: (onChange: () => void) => () => void;
};

export type MyWorkController = {
  state(): MyWorkState;
  subscribe(fn: () => void): () => void;
  refresh(): Promise<void>;
  dispose(): void;
};

export const MY_WORK_LOADING: MyWorkState = { status: 'loading', items: [] };

export function createMyWorkController({ fetchWork, currentUserId, listenAccountChanged }: MyWorkControllerDeps): MyWorkController {
  let current = MY_WORK_LOADING;
  let latest = 0;
  let reloadedForMismatch = false;
  let disposed = false;
  const listeners = new Set<() => void>();

  const set = (next: MyWorkState): void => {
    if (disposed || next === current) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };

  const load = async (): Promise<void> => {
    if (disposed) return;
    latest += 1;
    const request = latest;
    set(MY_WORK_LOADING);
    let reply: MyWorkReply;
    try {
      reply = await fetchWork();
    } catch (error) {
      if (request === latest) set({ status: 'error', items: [], error: error instanceof Error ? error.message : mittrT('mittr.work.error') });
      return;
    }
    if (request !== latest) return;
    if (reply.configured && reply.userId !== currentUserId()) {
      if (reloadedForMismatch) return;
      reloadedForMismatch = true;
      await load();
      return;
    }
    reloadedForMismatch = false;
    set(reply.configured ? { status: 'ready', items: reply.items } : { status: 'not-connected', items: [] });
  };

  const stopListening = listenAccountChanged(() => {
    reloadedForMismatch = false;
    void load();
  });

  return {
    state: () => current,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    refresh: load,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      latest += 1;
      stopListening();
      listeners.clear();
    },
  };
}

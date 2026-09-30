import { create } from 'zustand';

import { runtimeFetch } from '@/lib/runtime-fetch';

import { fetchAnsweredBy, type AnsweredByList } from './answered-by';

type LoadAnsweredBy = (sessionId: string) => Promise<AnsweredByList>;

interface AnsweredByStore {
  sessions: Record<string, AnsweredByList>;
  load: (sessionId: string, completedAt: number) => Promise<void>;
}

const readAnsweredBy: LoadAnsweredBy = (sessionId) => fetchAnsweredBy((input, init) => runtimeFetch(input, init), sessionId);

export function createAnsweredByStore(read: LoadAnsweredBy = readAnsweredBy) {
  const pending = new Map<string, Promise<void>>();

  return create<AnsweredByStore>((set, get) => ({
    sessions: {},
    load: (sessionId, completedAt) => {
      const inFlight = pending.get(sessionId);
      if (inFlight) return inFlight;
      const known = get().sessions[sessionId];
      if (known && known.now >= completedAt) return Promise.resolve();
      const request = read(sessionId)
        .then((list) => {
          set((state) => ({ sessions: { ...state.sessions, [sessionId]: list } }));
        })
        .catch(() => undefined)
        .finally(() => {
          pending.delete(sessionId);
        });
      pending.set(sessionId, request);
      return request;
    },
  }));
}

export const useAnsweredByStore = createAnsweredByStore();

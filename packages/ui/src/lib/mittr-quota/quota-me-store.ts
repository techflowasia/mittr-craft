import { create } from 'zustand';

import { runtimeFetch } from '@/lib/runtime-fetch';

import { fetchQuotaMe, type QuotaMeResult } from './quota-me';
import { useSpeechQuotaStore } from './speech-quota-store';

export type QuotaMeState = { status: 'loading' } | QuotaMeResult;

type LoadQuotaMe = () => Promise<QuotaMeResult>;

export const QUOTA_ME_FRESH_MS = 30_000;

export const MITTR_PROVIDER_ID = 'mittr';

export type MittrProviderId = typeof MITTR_PROVIDER_ID;

interface QuotaMeStore {
  state: QuotaMeState;
  loadedAt: number | null;
  load: (options?: { force?: boolean; now?: number }) => Promise<void>;
}

const readQuotaMe: LoadQuotaMe = () => fetchQuotaMe((input, init) => runtimeFetch(input, init));

export function createQuotaMeStore(read: LoadQuotaMe = readQuotaMe) {
  let pending: Promise<void> | null = null;

  return create<QuotaMeStore>((set, get) => ({
    state: { status: 'loading' },
    loadedAt: null,
    load: ({ force = false, now = Date.now() } = {}) => {
      if (pending) return pending;
      const { loadedAt, state } = get();
      if (!force && loadedAt !== null && state.status !== 'loading' && now - loadedAt < QUOTA_ME_FRESH_MS) {
        return Promise.resolve();
      }
      if (force || state.status !== 'ok') set({ state: { status: 'loading' } });
      pending = read()
        .catch((): QuotaMeResult => ({ status: 'failed' }))
        .then((result) => {
          if (result.status === 'ok') useSpeechQuotaStore.getState().reconcile(result.quota.lines);
          set({ state: result, loadedAt: Date.now() });
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
  }));
}

export const useQuotaMeStore = createQuotaMeStore();

import { mittrT } from '../strings/mittrT';
import type { SuggestionStyle, SuggestionStyleApi } from './suggestionStyleApi';

export type SuggestionStyleState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; suggestionStyle: SuggestionStyle; canChange: boolean; saving: boolean };

export type SuggestionStyleController = {
  state(): SuggestionStyleState;
  subscribe(fn: () => void): () => void;
  load(): Promise<void>;
  choose(style: SuggestionStyle): Promise<string | null>;
  dispose(): void;
};

export const SUGGESTION_STYLE_LOADING: SuggestionStyleState = { status: 'loading' };

const messageOf = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback);

export function createSuggestionStyleController({ api }: { api: SuggestionStyleApi }): SuggestionStyleController {
  let current: SuggestionStyleState = SUGGESTION_STYLE_LOADING;
  let generation = 0;
  let disposed = false;
  const listeners = new Set<() => void>();

  const set = (next: SuggestionStyleState): void => {
    if (disposed) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };

  const load = async (): Promise<void> => {
    if (disposed) return;
    generation += 1;
    const request = generation;
    if (current.status === 'error') set(SUGGESTION_STYLE_LOADING);
    try {
      const settings = await api.load();
      if (request === generation) set({ status: 'ready', suggestionStyle: settings.suggestionStyle, canChange: settings.canChange, saving: false });
    } catch (error) {
      if (request === generation) set({ status: 'error', error: messageOf(error, mittrT('mittr.chat.suggestions.errors.loadFailed')) });
    }
  };

  const choose = async (style: SuggestionStyle): Promise<string | null> => {
    if (disposed || current.status !== 'ready' || !current.canChange || current.saving || current.suggestionStyle === style) return null;
    const before = current;
    generation += 1;
    const request = generation;
    set({ ...before, suggestionStyle: style, saving: true });
    try {
      const stored = await api.save(style);
      if (request === generation) set({ status: 'ready', suggestionStyle: stored.suggestionStyle, canChange: stored.canChange, saving: false });
      return null;
    } catch (error) {
      if (request === generation) set({ ...before, saving: false });
      return messageOf(error, mittrT('mittr.chat.suggestions.errors.saveFailed'));
    }
  };

  return {
    state: () => current,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    load,
    choose,
    dispose: () => {
      disposed = true;
      generation += 1;
      listeners.clear();
    },
  };
}

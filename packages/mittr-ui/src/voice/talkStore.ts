import React from 'react';

import type { VoicePhase } from './voiceSession';
import type { VoiceReadiness } from './voiceApi';

export interface TalkState {
  readiness: VoiceReadiness | null;
  phase: VoicePhase;
  toggle: () => void;
  narrate: (text: string, tag?: string) => void;
  narrator: string | null;
  button: HTMLButtonElement | null;
}

const INITIAL: TalkState = { readiness: null, phase: 'idle', toggle: () => {}, narrate: () => {}, narrator: null, button: null };

let state: TalkState = INITIAL;
const listeners = new Set<() => void>();

export const talkStore = {
  getState: (): TalkState => state,
  setState(patch: Partial<TalkState>): void {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  },
  reset(): void {
    state = INITIAL;
    for (const listener of [...listeners]) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function claimNarrator(id: string): void {
  if (state.narrator === null) talkStore.setState({ narrator: id });
}

export function releaseNarrator(id: string): void {
  if (state.narrator === id) talkStore.setState({ narrator: null });
}

export function useTalkState<T>(select: (current: TalkState) => T): T {
  return React.useSyncExternalStore(talkStore.subscribe, () => select(talkStore.getState()), () => select(talkStore.getState()));
}

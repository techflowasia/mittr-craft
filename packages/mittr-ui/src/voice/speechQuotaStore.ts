import React from 'react';

import { isStillBlocked, nextWeeklyReset } from './week';

export type SpeechQuotaKind = 'stt' | 'tts';

export type SpeechUsageLine = { kind: string; used: number; limit: number };

export interface SpeechQuotaState {
  owner: string | null;
  stt: string | null;
  tts: string | null;
}

const SPEECH_KINDS: readonly SpeechQuotaKind[] = ['stt', 'tts'];

const EMPTY: SpeechQuotaState = { owner: null, stt: null, tts: null };

let state: SpeechQuotaState = EMPTY;
const listeners = new Set<() => void>();

const write = (next: SpeechQuotaState): void => {
  if (next.owner === state.owner && next.stt === state.stt && next.tts === state.tts) return;
  state = next;
  for (const listener of [...listeners]) listener();
};

export const speechQuotaStore = {
  getState: (): SpeechQuotaState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  reset(): void {
    write(EMPTY);
  },
  setOwner(owner: string | null): void {
    if (owner === state.owner) return;
    write({ owner, stt: null, tts: null });
  },
  block(kind: SpeechQuotaKind, resetsAt: string | null, now = Date.now()): string {
    const blockedUntil = resetsAt ?? nextWeeklyReset(now);
    write(kind === 'stt' ? { ...state, stt: blockedUntil } : { ...state, tts: blockedUntil });
    return blockedUntil;
  },
  clear(kind: SpeechQuotaKind): void {
    write(kind === 'stt' ? { ...state, stt: null } : { ...state, tts: null });
  },
  reconcile(lines: readonly SpeechUsageLine[]): void {
    for (const kind of SPEECH_KINDS) {
      if (lines.some((line) => line.kind === kind && line.used < line.limit)) speechQuotaStore.clear(kind);
    }
  },
};

export function speechBlockedUntil(kind: SpeechQuotaKind, now = Date.now()): string | null {
  const resetsAt = state[kind];
  return isStillBlocked(resetsAt, now) ? resetsAt : null;
}

export function useSpeechQuotaBlock(kind: SpeechQuotaKind): string | null {
  const resetsAt = React.useSyncExternalStore(speechQuotaStore.subscribe, () => state[kind], () => state[kind]);
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!resetsAt) return;
    const wait = Date.parse(resetsAt) - Date.now();
    if (wait <= 0) {
      setNow(Date.now());
      return;
    }
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(wait, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [resetsAt]);

  return isStillBlocked(resetsAt, Math.max(now, Date.now())) ? resetsAt : null;
}

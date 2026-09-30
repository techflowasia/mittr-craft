import React from 'react';
import { create } from 'zustand';

import type { QuotaUsageLine } from './quota-me';
import { isStillBlocked, nextWeeklyReset } from './week';

export type SpeechQuotaKind = 'stt' | 'tts';

interface SpeechQuotaState {
  owner: string | null;
  stt: string | null;
  tts: string | null;
  setOwner: (owner: string | null) => void;
  block: (kind: SpeechQuotaKind, resetsAt: string | null, now?: number) => string;
  clear: (kind: SpeechQuotaKind) => void;
  reconcile: (lines: readonly QuotaUsageLine[]) => void;
}

const SPEECH_KINDS: readonly SpeechQuotaKind[] = ['stt', 'tts'];

export const useSpeechQuotaStore = create<SpeechQuotaState>((set, get) => ({
  owner: null,
  stt: null,
  tts: null,
  setOwner: (owner) => {
    if (owner === get().owner) return;
    set({ owner, stt: null, tts: null });
  },
  block: (kind, resetsAt, now = Date.now()) => {
    const until = resetsAt ?? nextWeeklyReset(now);
    set({ [kind]: until } as Pick<SpeechQuotaState, SpeechQuotaKind>);
    return until;
  },
  clear: (kind) => {
    if (get()[kind] !== null) set({ [kind]: null } as Pick<SpeechQuotaState, SpeechQuotaKind>);
  },
  reconcile: (lines) => {
    for (const kind of SPEECH_KINDS) {
      if (lines.some((line) => line.kind === kind && line.used < line.limit)) get().clear(kind);
    }
  },
}));

export function speechBlockedUntil(kind: SpeechQuotaKind, now = Date.now()): string | null {
  const resetsAt = useSpeechQuotaStore.getState()[kind];
  return isStillBlocked(resetsAt, now) ? resetsAt : null;
}

export function useSpeechQuotaBlock(kind: SpeechQuotaKind): string | null {
  const resetsAt = useSpeechQuotaStore((state) => state[kind]);
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

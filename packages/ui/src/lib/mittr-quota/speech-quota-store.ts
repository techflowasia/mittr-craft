import React from 'react';
import { create } from 'zustand';

import { isStillBlocked, nextWeeklyReset } from './week';

export type SpeechQuotaKind = 'stt' | 'tts';

interface SpeechQuotaState {
  stt: string | null;
  tts: string | null;
  block: (kind: SpeechQuotaKind, resetsAt: string | null, now?: number) => string;
}

export const useSpeechQuotaStore = create<SpeechQuotaState>((set) => ({
  stt: null,
  tts: null,
  block: (kind, resetsAt, now = Date.now()) => {
    const until = resetsAt ?? nextWeeklyReset(now);
    set({ [kind]: until } as Pick<SpeechQuotaState, SpeechQuotaKind>);
    return until;
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

import { create } from 'zustand';

import type { VoicePhase } from './session';
import type { VoiceReadiness } from './turn';

export interface TalkState {
  readiness: VoiceReadiness | null;
  phase: VoicePhase;
  toggle: () => void;
  button: HTMLButtonElement | null;
}

export const useTalkStore = create<TalkState>(() => ({
  readiness: null,
  phase: 'idle',
  toggle: () => {},
  button: null,
}));

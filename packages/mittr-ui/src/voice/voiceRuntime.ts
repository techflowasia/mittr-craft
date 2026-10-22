import { runtimeFetch } from '../../../ui/src/lib/runtime-fetch';
import { createAudioPlayer } from './player';
import type { VoiceFetch } from './voiceApi';
import type { VoicePlayback } from './voiceSession';

export const voiceFetch: VoiceFetch = (input, init) => runtimeFetch(input, init);

export function browserPlayer(): VoicePlayback {
  const context = new AudioContext();
  void context.resume().catch(() => {});
  return {
    player: createAudioPlayer(context),
    close: () => {
      void context.close().catch(() => {});
    },
  };
}

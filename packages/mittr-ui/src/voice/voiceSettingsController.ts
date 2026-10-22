import { mittrT } from '../strings/mittrT';
import type { SpeechOffer, UpstreamSpeech } from './upstreamSpeech';
import type { SynthesizeSpeech, VoiceReadiness } from './voiceApi';
import type { VoicePlayback } from './voiceSession';
import type { VoiceLimits, VoiceLimitsPatch, VoiceSettingsApi } from './voiceSettingsApi';

export type VoiceSettingsLoad =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; offer: SpeechOffer; limits: VoiceLimits | null; readiness: VoiceReadiness | null };

export type VoiceSettingsControllerState = { load: VoiceSettingsLoad; previewing: boolean };

export type VoiceSettingsOutcome = { tone: 'error'; text: string } | null;

export type VoiceSettingsSpeech = Pick<
  UpstreamSpeech,
  'readOffer' | 'chooseMittrDictation' | 'chooseMittrReadAloud' | 'stopMittrDictation' | 'stopMittrReadAloud'
>;

export interface VoiceSettingsDeps {
  api: VoiceSettingsApi;
  speech: VoiceSettingsSpeech;
  readiness: () => Promise<VoiceReadiness | null>;
  synthesize: SynthesizeSpeech;
  createPlayer: () => VoicePlayback;
}

export type VoiceSettingsController = {
  state(): VoiceSettingsControllerState;
  subscribe(fn: () => void): () => void;
  load(): Promise<void>;
  setDictation(on: boolean): Promise<VoiceSettingsOutcome>;
  setReadAloud(on: boolean): Promise<VoiceSettingsOutcome>;
  setStepCap(value: number): Promise<VoiceSettingsOutcome>;
  setReplyMaxChars(value: number): Promise<VoiceSettingsOutcome>;
  preview(): Promise<VoiceSettingsOutcome>;
  dispose(): void;
};

export const VOICE_SETTINGS_LOADING: VoiceSettingsControllerState = { load: { status: 'loading' }, previewing: false };

const messageOf = (error: Error | null, fallback: string): string => error?.message || fallback;

export function createVoiceSettingsController(deps: VoiceSettingsDeps): VoiceSettingsController {
  let current = VOICE_SETTINGS_LOADING;
  let generation = 0;
  let disposed = false;
  let stopPreview: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const set = (next: VoiceSettingsControllerState): void => {
    if (disposed || next === current) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };

  const readyLoad = () => (current.load.status === 'ready' ? current.load : null);

  const load = async (): Promise<void> => {
    if (disposed) return;
    generation += 1;
    const request = generation;
    if (current.load.status === 'error') set({ ...current, load: { status: 'loading' } });
    const failure = (error: Error | null): void => {
      if (request === generation) set({ ...current, load: { status: 'error', error: messageOf(error, mittrT('mittr.voice.settings.errors.loadFailed')) } });
    };
    let offer: SpeechOffer | null;
    try {
      offer = await deps.speech.readOffer();
    } catch (error) {
      failure(error instanceof Error ? error : null);
      return;
    }
    if (request !== generation) return;
    if (!offer) {
      failure(null);
      return;
    }
    if (!offer.offered) {
      set({ ...current, load: { status: 'ready', offer, limits: null, readiness: null } });
      return;
    }
    let limits: VoiceLimits;
    let readiness: VoiceReadiness | null;
    try {
      [limits, readiness] = await Promise.all([deps.api.load(), deps.readiness().catch(() => null)]);
    } catch (error) {
      failure(error instanceof Error ? error : null);
      return;
    }
    if (request === generation) set({ ...current, load: { status: 'ready', offer, limits, readiness } });
  };

  const switchTo = async (
    on: boolean,
    choose: (baseUrl: string) => Promise<boolean>,
    stop: () => Promise<boolean>,
  ): Promise<VoiceSettingsOutcome> => {
    const ready = readyLoad();
    if (disposed || !ready || !ready.offer.offered) return null;
    const failed: VoiceSettingsOutcome = { tone: 'error', text: mittrT('mittr.voice.settings.errors.switchFailed') };
    let done: boolean;
    try {
      done = on ? await choose(ready.offer.baseUrl) : await stop();
    } catch {
      done = false;
    }
    if (done) return null;
    if (on) await stop().catch(() => false);
    void load();
    return failed;
  };

  const writeLimit = async (patch: VoiceLimitsPatch): Promise<VoiceSettingsOutcome> => {
    const ready = readyLoad();
    if (disposed || !ready?.limits?.canChange) return null;
    generation += 1;
    const request = generation;
    set({ ...current, load: { ...ready, limits: { ...ready.limits, ...patch } } });
    let stored: VoiceLimits;
    try {
      stored = await deps.api.save(patch);
    } catch (error) {
      if (disposed || request !== generation) return null;
      void load();
      return { tone: 'error', text: messageOf(error instanceof Error ? error : null, mittrT('mittr.voice.settings.errors.saveFailed')) };
    }
    const latest = readyLoad();
    if (request === generation && latest) set({ ...current, load: { ...latest, limits: stored } });
    return null;
  };

  const preview = async (): Promise<VoiceSettingsOutcome> => {
    if (disposed) return null;
    if (stopPreview) {
      stopPreview();
      return null;
    }
    const abort = new AbortController();
    let playback: VoicePlayback | null = null;
    stopPreview = () => {
      abort.abort();
      playback?.player.stop();
    };
    set({ ...current, previewing: true });
    try {
      const audio = await deps.synthesize(mittrT('mittr.voice.settings.previewLine'), abort.signal);
      if (abort.signal.aborted) return null;
      playback = deps.createPlayer();
      await playback.player.play(audio.contentType, audio.body);
      await playback.player.drained();
      return null;
    } catch {
      if (abort.signal.aborted) return null;
      return { tone: 'error', text: mittrT('mittr.voice.settings.errors.previewFailed') };
    } finally {
      playback?.close();
      stopPreview = null;
      set({ ...current, previewing: false });
    }
  };

  return {
    state: () => current,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    load,
    setDictation: (on) => switchTo(on, deps.speech.chooseMittrDictation, deps.speech.stopMittrDictation),
    setReadAloud: (on) => switchTo(on, deps.speech.chooseMittrReadAloud, deps.speech.stopMittrReadAloud),
    setStepCap: (value) => writeLimit({ stepCap: value }),
    setReplyMaxChars: (value) => writeLimit({ replyMaxChars: value }),
    preview,
    dispose: () => {
      if (disposed) return;
      stopPreview?.();
      disposed = true;
      generation += 1;
      listeners.clear();
    },
  };
}

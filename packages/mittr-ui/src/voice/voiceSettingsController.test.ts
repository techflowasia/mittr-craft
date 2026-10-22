import { describe, expect, test } from 'bun:test';

import { mittrT } from '../strings/mittrT';
import { createUpstreamSpeech, type SpeechConfig, type SpeechOffer } from './upstreamSpeech';
import type { SynthesizedAudio, VoiceReadiness } from './voiceApi';
import type { VoiceLimits, VoiceLimitsPatch, VoiceSettingsApi } from './voiceSettingsApi';
import { VoiceSettingsRequestError } from './voiceSettingsApi';
import { createVoiceSettingsController, VOICE_SETTINGS_LOADING, type VoiceSettingsControllerState } from './voiceSettingsController';

type Deferred<T> = { resolve: (value: T) => void; reject: (error: Error) => void };

const BASE_URL = 'http://127.0.0.1:4100/mittr-speech/v1';

const OFFER: SpeechOffer = {
  offered: true,
  baseUrl: BASE_URL,
  model: 'mittr',
  voice: 'mittr',
  installed: { stt: false, openaiCompatible: false },
  carryDictation: false,
};

const LIMITS: VoiceLimits = { stepCap: 8, replyMaxChars: 8000, canChange: true };

const READY: VoiceReadiness = { listen: true, speak: true, voice: true, signedIn: true, here: true, voiceSilenceMs: 900, reason: null };

type SetupOptions = { offer?: SpeechOffer | null; readiness?: VoiceReadiness | null; speechResult?: boolean };

const setup = ({ offer = OFFER, readiness = READY, speechResult = true }: SetupOptions = {}) => {
  const loads: Deferred<VoiceLimits>[] = [];
  const saves: Array<Deferred<VoiceLimits> & { patch: VoiceLimitsPatch }> = [];
  const calls: string[] = [];
  const api: VoiceSettingsApi = {
    load: () => new Promise((resolve, reject) => { loads.push({ resolve, reject }); }),
    save: (patch) => new Promise((resolve, reject) => { saves.push({ resolve, reject, patch }); }),
  };
  const speech = {
    readOffer: async () => offer,
    chooseMittrDictation: async (baseUrl: string) => { calls.push(`chooseDictation ${baseUrl}`); return speechResult; },
    chooseMittrReadAloud: async (baseUrl: string) => { calls.push(`chooseReadAloud ${baseUrl}`); return speechResult; },
    stopMittrDictation: async () => { calls.push('stopDictation'); return speechResult; },
    stopMittrReadAloud: async () => { calls.push('stopReadAloud'); return speechResult; },
  };
  const previews: Array<{ text: string; played: string[]; stopped: number; closed: number; release: () => void }> = [];
  const synthesize = async (text: string): Promise<SynthesizedAudio> => {
    calls.push(`synthesize ${text}`);
    return { contentType: 'audio/pcm; rate=24000', body: new ReadableStream() };
  };
  const createPlayer = () => {
    let release = () => {};
    const played: string[] = [];
    const entry = { text: '', played, stopped: 0, closed: 0, release: () => release() };
    previews.push(entry);
    return {
      player: {
        busy: false,
        play: async (contentType: string) => { entry.played.push(contentType); },
        drained: () => new Promise<void>((resolve) => { release = resolve; }),
        stop: () => { entry.stopped += 1; release(); },
      },
      close: () => { entry.closed += 1; },
    };
  };
  const controller = createVoiceSettingsController({ api, speech, readiness: async () => readiness, synthesize, createPlayer });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const ready = async (limits: VoiceLimits = LIMITS) => {
    const loading = controller.load();
    await settle();
    loads.at(-1)?.resolve(limits);
    await loading;
    await settle();
  };
  return { controller, loads, saves, calls, previews, settle, ready };
};

const readyOf = (state: VoiceSettingsControllerState) => (state.load.status === 'ready' ? state.load : null);

describe('MittrCraft voice settings controller', () => {
  test('it starts loading, then holds the offer, the limits and the platform readiness', async () => {
    const { controller, ready } = setup();
    expect(controller.state()).toEqual(VOICE_SETTINGS_LOADING);
    await ready();
    expect(controller.state()).toEqual({ load: { status: 'ready', offer: OFFER, limits: LIMITS, readiness: READY }, previewing: false });
  });

  test('a hosted runtime reads nothing else and holds no limits', async () => {
    const { controller, loads, settle } = setup({ offer: { ...OFFER, offered: false, baseUrl: null } });
    await controller.load();
    await settle();
    expect(loads).toHaveLength(0);
    expect(readyOf(controller.state())).toEqual({ status: 'ready', offer: { ...OFFER, offered: false, baseUrl: null }, limits: null, readiness: null });
  });

  test('the exact body a hosted server sends reads as nothing to show, not a load failure', async () => {
    const hosted = { offered: false, baseUrl: null, model: 'mittr', voice: 'mittr', installed: { stt: false, openaiCompatible: false }, carryDictation: false };
    const speech = createUpstreamSpeech({
      config: (): SpeechConfig => { throw new Error('a hosted runtime changes no speech settings'); },
      fetch: async () => new Response(JSON.stringify(hosted)),
    });
    const loads: VoiceLimits[] = [];
    const controller = createVoiceSettingsController({
      api: { load: async () => { loads.push(LIMITS); return LIMITS; }, save: async () => LIMITS },
      speech,
      readiness: async () => READY,
      synthesize: async () => ({ contentType: 'audio/pcm; rate=24000', body: new ReadableStream() }),
      createPlayer: () => { throw new Error('nothing plays'); },
    });
    await controller.load();
    expect(loads).toHaveLength(0);
    expect(controller.state().load).toEqual({ status: 'ready', offer: hosted, limits: null, readiness: null });
  });

  test('an offer that cannot be read, or limits that cannot, are a load failure with a retry', async () => {
    const none = setup({ offer: null });
    await none.controller.load();
    expect(none.controller.state().load).toEqual({ status: 'error', error: mittrT('mittr.voice.settings.errors.loadFailed') });

    const broken = setup();
    const loading = broken.controller.load();
    await broken.settle();
    broken.loads[0].reject(new VoiceSettingsRequestError('Could not read the voice settings', 500));
    await loading;
    expect(broken.controller.state().load).toEqual({ status: 'error', error: 'Could not read the voice settings' });
    await broken.ready();
    expect(readyOf(broken.controller.state())?.limits).toEqual(LIMITS);
  });

  test('a switch turned on calls chooseMittrDictation with the server\'s base URL', async () => {
    const { controller, calls, ready } = setup();
    await ready();
    expect(await controller.setDictation(true)).toBeNull();
    expect(calls).toEqual([`chooseDictation ${BASE_URL}`]);
    expect(await controller.setReadAloud(true)).toBeNull();
    expect(calls).toEqual([`chooseDictation ${BASE_URL}`, `chooseReadAloud ${BASE_URL}`]);
  });

  test('a switch turned off stops Mittr for that kind only', async () => {
    const { controller, calls, ready } = setup();
    await ready();
    expect(await controller.setDictation(false)).toBeNull();
    expect(await controller.setReadAloud(false)).toBeNull();
    expect(calls).toEqual(['stopDictation', 'stopReadAloud']);
  });

  test('a switch whose key could not be stored is taken back and says so', async () => {
    const { controller, calls, ready } = setup({ speechResult: false });
    await ready();
    expect(await controller.setReadAloud(true)).toEqual({ tone: 'error', text: mittrT('mittr.voice.settings.errors.switchFailed') });
    expect(calls).toEqual([`chooseReadAloud ${BASE_URL}`, 'stopReadAloud']);
  });

  test('a limit is shown at once, saved, then replaced by what the server stored', async () => {
    const { controller, saves, ready, settle } = setup();
    await ready();
    const writing = controller.setStepCap(12);
    expect(readyOf(controller.state())?.limits).toEqual({ ...LIMITS, stepCap: 12 });
    expect(saves[0].patch).toEqual({ stepCap: 12 });
    saves[0].resolve({ ...LIMITS, stepCap: 12 });
    expect(await writing).toBeNull();
    await settle();
    expect(readyOf(controller.state())?.limits).toEqual({ ...LIMITS, stepCap: 12 });

    const second = controller.setReplyMaxChars(3000);
    expect(saves[1].patch).toEqual({ replyMaxChars: 3000 });
    saves[1].resolve({ ...LIMITS, stepCap: 12, replyMaxChars: 3000 });
    await second;
    expect(readyOf(controller.state())?.limits).toEqual({ ...LIMITS, stepCap: 12, replyMaxChars: 3000 });
  });

  test('a failed write reloads the stored state', async () => {
    const { controller, saves, loads, ready, settle } = setup();
    await ready();
    const writing = controller.setStepCap(99);
    saves[0].reject(new VoiceSettingsRequestError('Unknown or invalid voice setting: stepCap', 400));
    expect(await writing).toEqual({ tone: 'error', text: 'Unknown or invalid voice setting: stepCap' });
    await settle();
    expect(loads).toHaveLength(2);
    loads[1].resolve(LIMITS);
    await settle();
    expect(readyOf(controller.state())?.limits).toEqual(LIMITS);
  });

  test('a limit cannot be written by a client that may not change it', async () => {
    const { controller, saves, ready } = setup();
    await ready({ ...LIMITS, canChange: false });
    expect(await controller.setStepCap(3)).toBeNull();
    expect(saves).toHaveLength(0);
  });

  test('the newest write wins over an older answer that arrives late', async () => {
    const { controller, saves, ready, settle } = setup();
    await ready();
    const first = controller.setStepCap(5);
    const second = controller.setStepCap(6);
    saves[1].resolve({ ...LIMITS, stepCap: 6 });
    await second;
    saves[0].resolve({ ...LIMITS, stepCap: 5 });
    await first;
    await settle();
    expect(readyOf(controller.state())?.limits?.stepCap).toBe(6);
  });

  test('the preview speaks 1.22\'s sentence through the voice route and stops when asked again', async () => {
    const { controller, calls, previews, ready, settle } = setup();
    await ready();
    const playing = controller.preview();
    await settle();
    expect(controller.state().previewing).toBe(true);
    expect(calls).toContain(`synthesize ${mittrT('mittr.voice.settings.previewLine')}`);
    expect(mittrT('mittr.voice.settings.previewLine')).toBe("Hello! I'm Mittr. This is how I sound.");
    expect(previews[0].played).toEqual(['audio/pcm; rate=24000']);
    expect(await controller.preview()).toBeNull();
    expect(await playing).toBeNull();
    expect(previews[0].stopped).toBe(1);
    expect(previews[0].closed).toBe(1);
    expect(controller.state().previewing).toBe(false);
  });

  test('a preview that cannot be played says so and ends', async () => {
    const broken = createVoiceSettingsController({
      api: { load: async () => LIMITS, save: async () => LIMITS },
      speech: { readOffer: async () => OFFER, chooseMittrDictation: async () => true, chooseMittrReadAloud: async () => true, stopMittrDictation: async () => true, stopMittrReadAloud: async () => true },
      readiness: async () => READY,
      synthesize: async () => { throw new Error('refused'); },
      createPlayer: () => { throw new Error('no player'); },
    });
    await broken.load();
    expect(await broken.preview()).toEqual({ tone: 'error', text: mittrT('mittr.voice.settings.errors.previewFailed') });
    expect(broken.state().previewing).toBe(false);
  });

  test('disposing stops a preview and ignores later answers', async () => {
    const { controller, previews, ready, settle } = setup();
    await ready();
    const playing = controller.preview();
    await settle();
    controller.dispose();
    await playing;
    expect(previews[0].stopped).toBe(1);
    expect(previews[0].closed).toBe(1);
    expect(await controller.setStepCap(3)).toBeNull();
  });
});

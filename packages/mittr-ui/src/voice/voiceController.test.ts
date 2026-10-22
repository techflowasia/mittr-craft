import { afterEach, describe, expect, test } from 'bun:test';

import type { StartConversationListening } from './listen';
import type { AudioPlayer } from './player';
import { speechQuotaStore } from './speechQuotaStore';
import { talkStore } from './talkStore';
import type { FirstRunFacts, SpeechOffer } from './upstreamSpeech';
import type { VoiceApi, VoiceReadiness } from './voiceApi';
import { READINESS_REFRESH_MS, createVoiceController, type VoiceControllerDeps, type VoiceWindow } from './voiceController';

const READY: VoiceReadiness = { listen: true, speak: true, voice: true, signedIn: true, here: true, voiceSilenceMs: 700, reason: null };
const BASE_URL = 'http://127.0.0.1:57188/mittr-speech/v1';
const OFFER: SpeechOffer = { offered: true, baseUrl: BASE_URL, model: 'mittr', voice: 'mittr', installed: { stt: false, openaiCompatible: false }, carryDictation: true };

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeWindow() {
  const target = new EventTarget();
  const intervals: { fn: () => void; ms: number }[] = [];
  let cleared = 0;
  const window: VoiceWindow = Object.assign(target, {
    setInterval: (fn: () => void, ms?: number) => {
      intervals.push({ fn, ms: ms ?? 0 });
      return intervals.length;
    },
    clearInterval: () => {
      cleared += 1;
    },
  });
  return { window, intervals, cleared: () => cleared };
}

const player: AudioPlayer = {
  play: async () => {},
  drained: async () => {},
  stop: () => {},
  busy: false,
};

type Calls = {
  readiness: number;
  starts: number;
  ends: string[];
  listened: number[];
  speechStates: number;
  speechStops: number;
  firstRuns: FirstRunFacts[];
  ports: string[];
};

function harness(patch: Partial<VoiceControllerDeps> = {}) {
  const calls: Calls = { readiness: 0, starts: 0, ends: [], listened: [], speechStates: 0, speechStops: 0, firstRuns: [], ports: [] };
  let readiness: VoiceReadiness | null = READY;
  let accountListener: (() => void) | null = null;
  let account: string | null = 'u1';
  const api: VoiceApi = {
    readiness: async () => {
      calls.readiness += 1;
      return readiness;
    },
    start: async () => {
      calls.starts += 1;
      return `conv_${calls.starts}`;
    },
    end: async (conversationId) => {
      calls.ends.push(conversationId);
    },
    transcribe: async () => ({ text: 'hello', heard: 'heard_1' }),
    synthesize: async () => {
      throw new Error('not in this test');
    },
    turn: async function* () {
      yield { type: 'done' };
    },
  };
  const listen: StartConversationListening = async (options) => {
    calls.listened.push(options.silenceMs);
    return { destroy: () => {} };
  };
  const win = fakeWindow();
  const deps: VoiceControllerDeps = {
    api,
    listen,
    createPlayer: () => ({ player, close: () => {} }),
    context: () => ({}),
    queue: async () => true,
    speech: {
      readOffer: async () => OFFER,
      followPort: (baseUrl) => {
        calls.ports.push(baseUrl);
      },
      readLocalModelInstalled: async () => false,
      applyFirstRun: async (_baseUrl, facts) => {
        calls.firstRuns.push(facts);
      },
    },
    savedChoices: () => ({ vscode: false, savedSttProvider: false, savedVoiceProvider: true, localModelSaved: false }),
    firstRunMark: { applied: () => false, apply: () => {} },
    startSpeechState: () => {
      calls.speechStates += 1;
      return () => {
        calls.speechStops += 1;
      };
    },
    watchAccount: (listener) => {
      accountListener = listener;
      return () => {
        accountListener = null;
      };
    },
    account: () => account,
    window: win.window,
    ...patch,
  };
  const controller = createVoiceController(deps);
  return {
    controller,
    calls,
    win,
    setReadiness(next: VoiceReadiness | null) {
      readiness = next;
    },
    switchAccount(next: string | null) {
      account = next;
      accountListener?.();
    },
  };
}

const escape = () => Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });

afterEach(() => {
  talkStore.reset();
  speechQuotaStore.reset();
});

describe('the voice controller', () => {
  test('readiness refreshes at start, every 60 s and on window focus, and reaches the Talk button', async () => {
    const h = harness();
    const detach = h.controller.attach();
    await flush();
    expect(h.calls.readiness).toBe(1);
    expect(talkStore.getState().readiness).toEqual(READY);
    expect(h.win.intervals.map((interval) => interval.ms)).toEqual([READINESS_REFRESH_MS]);
    h.win.intervals[0]?.fn();
    h.win.window.dispatchEvent(new Event('focus'));
    await flush();
    expect(h.calls.readiness).toBe(3);
    detach();
    expect(h.win.cleared()).toBe(1);
  });

  test('Talk starts a conversation with the voice silence and a second press ends it', async () => {
    const h = harness();
    const detach = h.controller.attach();
    await flush();
    talkStore.getState().toggle();
    await flush();
    expect(h.calls.listened).toEqual([700]);
    expect(talkStore.getState().phase).toBe('listening');
    talkStore.getState().toggle();
    expect(talkStore.getState().phase).toBe('idle');
    expect(h.calls.ends).toEqual(['conv_1']);
    detach();
  });

  test('Talk does nothing while voice input is out of quota or voice is not ready', async () => {
    const h = harness();
    const detach = h.controller.attach();
    await flush();
    speechQuotaStore.block('stt', '2099-10-26T17:00:00.000Z');
    h.controller.toggle();
    await flush();
    speechQuotaStore.clear('stt');
    h.setReadiness({ ...READY, here: false });
    await h.controller.refreshReadiness();
    h.controller.toggle();
    await flush();
    expect(h.calls.starts).toBe(0);
    detach();
  });

  test('Escape ends the conversation', async () => {
    const h = harness();
    const detach = h.controller.attach();
    await flush();
    h.controller.toggle();
    await flush();
    h.win.window.dispatchEvent(escape());
    expect(h.controller.session.getSnapshot().phase).toBe('idle');
    expect(h.calls.ends).toEqual(['conv_1']);
    h.controller.toggle();
    await flush();
    detach();
    h.win.window.dispatchEvent(escape());
    expect(h.calls.ends).toEqual(['conv_1', 'conv_2']);
  });

  test('an account switch ends the conversation', async () => {
    const h = harness();
    const detach = h.controller.attach();
    await flush();
    speechQuotaStore.block('stt', '2099-10-26T17:00:00.000Z');
    h.controller.toggle();
    await flush();
    expect(h.calls.starts).toBe(0);
    speechQuotaStore.clear('stt');
    h.controller.toggle();
    await flush();
    speechQuotaStore.block('tts', '2099-10-26T17:00:00.000Z');
    h.switchAccount('u2');
    await flush();
    expect(h.controller.session.getSnapshot().phase).toBe('idle');
    expect(h.calls.ends).toEqual(['conv_1']);
    expect(speechQuotaStore.getState()).toEqual({ owner: 'u2', stt: null, tts: null });
    expect(h.calls.readiness).toBe(2);
    detach();
  });

  test('the speech state client starts with the root and stops with it', () => {
    const h = harness();
    const detach = h.controller.attach();
    expect(h.calls.speechStates).toBe(1);
    detach();
    expect(h.calls.speechStops).toBe(1);
  });

  test('after sign-in the speech endpoint port is followed and the first run is applied once, with the facts it needs', async () => {
    const h = harness();
    const detach = h.controller.attach();
    await flush();
    await flush();
    expect(h.calls.ports).toEqual([BASE_URL]);
    expect(h.calls.firstRuns).toEqual([
      { vscode: false, savedSttProvider: false, savedVoiceProvider: true, localModelSaved: false, localModelInstalled: false, carryDictation: true },
    ]);
    detach();
  });

  test('a hosted runtime that offers no Mittr speech changes nothing', async () => {
    const h = harness();
    const ports: string[] = [];
    const hosted = harness({
      speech: {
        readOffer: async () => ({ ...OFFER, offered: false }),
        followPort: (baseUrl) => {
          ports.push(baseUrl);
        },
        readLocalModelInstalled: async () => false,
        applyFirstRun: async () => {
          throw new Error('must not run');
        },
      },
    });
    const detach = hosted.controller.attach();
    await flush();
    expect(ports).toEqual([]);
    detach();
    expect(h.calls.firstRuns).toEqual([]);
  });

  test('an unknown local model install skips the first run until the next load', async () => {
    const runs: FirstRunFacts[] = [];
    const h = harness({
      speech: {
        readOffer: async () => OFFER,
        followPort: () => {},
        readLocalModelInstalled: async () => null,
        applyFirstRun: async (_baseUrl, facts) => {
          runs.push(facts);
        },
      },
    });
    const detach = h.controller.attach();
    await flush();
    await flush();
    expect(runs).toEqual([]);
    detach();
  });
});

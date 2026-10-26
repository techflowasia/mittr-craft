import { describe, expect, test } from 'bun:test';

import {
  FIRST_RUN_MARK,
  createUpstreamSpeech,
  isMittrSpeechUrl,
  mittrDictationOn,
  mittrReadAloudOn,
  storageFirstRunMark,
  type FirstRunFacts,
  type FirstRunMark,
  type SpeechConfig,
} from './upstreamSpeech';
import type { VoiceFetch } from './voiceApi';

const BASE_URL = 'http://127.0.0.1:57188/mittr-speech/v1';

type Settings = {
  sttProvider: SpeechConfig['sttProvider'];
  sttServerUrl: string;
  sttModel: string;
  voiceProvider: SpeechConfig['voiceProvider'];
  openaiCompatibleUrl: string;
  openaiCompatibleTtsModel: string;
  openaiCompatibleVoice: string;
  ttsChunkedMode: boolean;
};

const UPSTREAM_DEFAULTS: Settings = {
  sttProvider: 'local',
  sttServerUrl: 'http://localhost:8001/v1',
  sttModel: 'deepdml/faster-whisper-large-v3-turbo-ct2',
  voiceProvider: 'browser',
  openaiCompatibleUrl: '',
  openaiCompatibleTtsModel: '',
  openaiCompatibleVoice: '',
  ttsChunkedMode: false,
};

function fakeConfig(initial: Partial<Settings> = {}) {
  const settings: Settings = { ...UPSTREAM_DEFAULTS, ...initial };
  const writes: string[] = [];
  let keyRefreshes = 0;
  const config = (): SpeechConfig => ({
    sttProvider: settings.sttProvider,
    sttServerUrl: settings.sttServerUrl,
    sttModel: settings.sttModel,
    voiceProvider: settings.voiceProvider,
    openaiCompatibleUrl: settings.openaiCompatibleUrl,
    openaiCompatibleTtsModel: settings.openaiCompatibleTtsModel,
    openaiCompatibleVoice: settings.openaiCompatibleVoice,
    ttsChunkedMode: settings.ttsChunkedMode,
    setSttProvider: (value) => {
      writes.push(`sttProvider=${value}`);
      settings.sttProvider = value;
    },
    setSttServerUrl: (value) => {
      writes.push(`sttServerUrl=${value}`);
      settings.sttServerUrl = value;
    },
    setSttModel: (value) => {
      writes.push(`sttModel=${value}`);
      settings.sttModel = value;
    },
    setVoiceProvider: (value) => {
      writes.push(`voiceProvider=${value}`);
      settings.voiceProvider = value;
    },
    setOpenaiCompatibleUrl: (value) => {
      writes.push(`openaiCompatibleUrl=${value}`);
      settings.openaiCompatibleUrl = value;
    },
    setOpenaiCompatibleTtsModel: (value) => {
      writes.push(`openaiCompatibleTtsModel=${value}`);
      settings.openaiCompatibleTtsModel = value;
    },
    setOpenaiCompatibleVoice: (value) => {
      writes.push(`openaiCompatibleVoice=${value}`);
      settings.openaiCompatibleVoice = value;
    },
    setTtsChunkedMode: (value) => {
      writes.push(`ttsChunkedMode=${value}`);
      settings.ttsChunkedMode = value;
    },
    refreshVoiceApiKeys: async (options) => {
      if (options?.force) keyRefreshes += 1;
    },
  });
  return { config, settings, writes, refreshes: () => keyRefreshes };
}

function recordingFetch(answer: () => Response = () => new Response(null, { status: 204 })) {
  const calls: { path: string; method: string; body: string | null }[] = [];
  const fetch: VoiceFetch = async (input, init) => {
    calls.push({ path: input, method: init?.method ?? 'GET', body: init?.body === undefined || init.body === null ? null : String(init.body) });
    return answer();
  };
  return { fetch, calls };
}

function memoryMark(applied = false): FirstRunMark & { applied: () => boolean } {
  let done = applied;
  return { applied: () => done, apply: () => { done = true; } };
}

const freshInstall: FirstRunFacts = {
  vscode: false,
  savedSttProvider: false,
  savedVoiceProvider: false,
  localModelSaved: false,
  localModelInstalled: false,
  carryDictation: false,
};

describe('the Mittr speech address', () => {
  test('is http on this Mac at exactly the Mittr speech path', () => {
    expect(isMittrSpeechUrl(BASE_URL)).toBe(true);
    expect(isMittrSpeechUrl('http://localhost:40001/mittr-speech/v1')).toBe(true);
    expect(isMittrSpeechUrl('https://127.0.0.1:57188/mittr-speech/v1')).toBe(false);
    expect(isMittrSpeechUrl('http://api.example.test/mittr-speech/v1')).toBe(false);
    expect(isMittrSpeechUrl('http://127.0.0.1:57188/mittr-speech/v1/audio')).toBe(false);
    expect(isMittrSpeechUrl('http://localhost:8001/v1')).toBe(false);
    expect(isMittrSpeechUrl('not a url')).toBe(false);
  });

  test('Mittr is the voice input or the read-aloud only when upstream points there', () => {
    expect(mittrDictationOn({ sttProvider: 'openai-compatible', sttServerUrl: BASE_URL })).toBe(true);
    expect(mittrDictationOn({ sttProvider: 'local', sttServerUrl: BASE_URL })).toBe(false);
    expect(mittrDictationOn({ sttProvider: 'openai-compatible', sttServerUrl: 'http://localhost:8001/v1' })).toBe(false);
    expect(mittrReadAloudOn({ voiceProvider: 'openai-compatible', openaiCompatibleUrl: BASE_URL })).toBe(true);
    expect(mittrReadAloudOn({ voiceProvider: 'browser', openaiCompatibleUrl: BASE_URL })).toBe(false);
  });
});

describe('choosing and stopping Mittr speech', () => {
  test("choosing Mittr voice input points upstream dictation at this run's speech endpoint and installs the key", async () => {
    const fake = fakeConfig();
    const net = recordingFetch();
    await createUpstreamSpeech({ config: fake.config, fetch: net.fetch }).chooseMittrDictation(BASE_URL);
    expect(fake.writes).toEqual(['sttProvider=openai-compatible', `sttServerUrl=${BASE_URL}`, 'sttModel=mittr']);
    expect(net.calls).toEqual([{ path: '/api/mittr/speech/key', method: 'PUT', body: JSON.stringify({ stt: true }) }]);
    expect(fake.refreshes()).toBe(1);
    expect(mittrDictationOn(fake.config())).toBe(true);
  });

  test('choosing Mittr read-aloud points upstream read-aloud at it, sentence by sentence, and installs its key', async () => {
    const fake = fakeConfig();
    const net = recordingFetch();
    await createUpstreamSpeech({ config: fake.config, fetch: net.fetch }).chooseMittrReadAloud(BASE_URL);
    expect(fake.writes).toEqual([
      'voiceProvider=openai-compatible',
      `openaiCompatibleUrl=${BASE_URL}`,
      'openaiCompatibleTtsModel=mittr',
      'openaiCompatibleVoice=mittr',
      'ttsChunkedMode=true',
    ]);
    expect(net.calls).toEqual([{ path: '/api/mittr/speech/key', method: 'PUT', body: JSON.stringify({ openaiCompatible: true }) }]);
    expect(mittrReadAloudOn(fake.config())).toBe(true);
  });

  test("stopping it restores upstream's provider and removes only our key", async () => {
    const fake = fakeConfig({ sttProvider: 'openai-compatible', sttServerUrl: BASE_URL, voiceProvider: 'openai-compatible', openaiCompatibleUrl: BASE_URL });
    const net = recordingFetch();
    const speech = createUpstreamSpeech({ config: fake.config, fetch: net.fetch });
    await speech.stopMittrDictation();
    await speech.stopMittrReadAloud();
    expect(fake.writes).toEqual(['sttProvider=local', 'voiceProvider=browser']);
    expect(net.calls.map((call) => call.body)).toEqual([JSON.stringify({ stt: false }), JSON.stringify({ openaiCompatible: false })]);
    expect(fake.refreshes()).toBe(2);
  });

  test('a key the server would not install is reported', async () => {
    const fake = fakeConfig();
    const net = recordingFetch(() => new Response(JSON.stringify({ error: 'These settings can be changed only on this Mac' }), { status: 403 }));
    expect(await createUpstreamSpeech({ config: fake.config, fetch: net.fetch }).chooseMittrDictation(BASE_URL)).toBe(false);
  });

  test('a choice whose key would not install puts back the provider the person had before', async () => {
    const own = {
      sttProvider: 'openai-compatible',
      sttServerUrl: 'https://stt.example.test/v1',
      sttModel: 'whisper-1',
      voiceProvider: 'say',
      openaiCompatibleUrl: 'https://tts.example.test/v1',
      openaiCompatibleTtsModel: 'tts-1',
      openaiCompatibleVoice: 'alloy',
      ttsChunkedMode: false,
    } satisfies Partial<Settings>;
    const fake = fakeConfig(own);
    const refused = recordingFetch(() => new Response(JSON.stringify({ error: 'The speech key could not be saved' }), { status: 500 }));
    const speech = createUpstreamSpeech({ config: fake.config, fetch: refused.fetch });
    expect(await speech.chooseMittrDictation(BASE_URL)).toBe(false);
    expect(await speech.chooseMittrReadAloud(BASE_URL)).toBe(false);
    expect({ ...fake.settings }).toEqual({ ...UPSTREAM_DEFAULTS, ...own });
    expect(fake.refreshes()).toBe(2);
  });
});

describe('following the port', () => {
  test('a changed port is followed and nothing else changes', () => {
    const fake = fakeConfig({
      sttProvider: 'openai-compatible',
      sttServerUrl: 'http://127.0.0.1:40001/mittr-speech/v1',
      voiceProvider: 'openai-compatible',
      openaiCompatibleUrl: 'http://127.0.0.1:40001/mittr-speech/v1',
    });
    createUpstreamSpeech({ config: fake.config, fetch: recordingFetch().fetch }).followPort(BASE_URL);
    expect(fake.writes).toEqual([`sttServerUrl=${BASE_URL}`, `openaiCompatibleUrl=${BASE_URL}`]);
  });

  test("a person's own speech server is never rewritten", () => {
    const fake = fakeConfig({ sttServerUrl: 'http://localhost:8001/v1', openaiCompatibleUrl: 'http://192.168.1.20:9000/mittr-speech/v1' });
    createUpstreamSpeech({ config: fake.config, fetch: recordingFetch().fetch }).followPort(BASE_URL);
    expect(fake.writes).toEqual([]);
  });

  test('the same port writes nothing', () => {
    const fake = fakeConfig({ sttServerUrl: BASE_URL, openaiCompatibleUrl: BASE_URL });
    createUpstreamSpeech({ config: fake.config, fetch: recordingFetch().fetch }).followPort(BASE_URL);
    expect(fake.writes).toEqual([]);
  });
});

describe('the first run', () => {
  test('a fresh install uses Mittr for both, once, unless a local model is installed', async () => {
    const fake = fakeConfig();
    const net = recordingFetch();
    const speech = createUpstreamSpeech({ config: fake.config, fetch: net.fetch });
    const mark = memoryMark();
    await speech.applyFirstRun(BASE_URL, freshInstall, mark);
    expect(mittrDictationOn(fake.config())).toBe(true);
    expect(mittrReadAloudOn(fake.config())).toBe(true);
    expect(mark.applied()).toBe(true);

    const again = fakeConfig();
    await createUpstreamSpeech({ config: again.config, fetch: net.fetch }).applyFirstRun(BASE_URL, freshInstall, mark);
    expect(again.writes).toEqual([]);

    const local = fakeConfig();
    await createUpstreamSpeech({ config: local.config, fetch: net.fetch }).applyFirstRun(BASE_URL, { ...freshInstall, localModelInstalled: true }, memoryMark());
    expect(mittrDictationOn(local.config())).toBe(false);
    expect(mittrReadAloudOn(local.config())).toBe(true);
  });

  test("a person's saved choices are kept", async () => {
    const fake = fakeConfig();
    await createUpstreamSpeech({ config: fake.config, fetch: recordingFetch().fetch }).applyFirstRun(
      BASE_URL,
      { ...freshInstall, savedSttProvider: true, savedVoiceProvider: true },
      memoryMark(),
    );
    expect(fake.writes).toEqual([]);
    const savedModel = fakeConfig();
    await createUpstreamSpeech({ config: savedModel.config, fetch: recordingFetch().fetch }).applyFirstRun(
      BASE_URL,
      { ...freshInstall, localModelSaved: true, savedVoiceProvider: true },
      memoryMark(),
    );
    expect(savedModel.writes).toEqual([]);
  });

  test('VS Code is left alone', async () => {
    const fake = fakeConfig();
    const mark = memoryMark();
    await createUpstreamSpeech({ config: fake.config, fetch: recordingFetch().fetch }).applyFirstRun(BASE_URL, { ...freshInstall, vscode: true, carryDictation: true }, mark);
    expect(fake.writes).toEqual([]);
    expect(mark.applied()).toBe(false);
  });

  test('a 1.22 Mittr dictation choice is carried once', async () => {
    const fake = fakeConfig();
    const net = recordingFetch();
    await createUpstreamSpeech({ config: fake.config, fetch: net.fetch }).applyFirstRun(
      BASE_URL,
      { ...freshInstall, savedSttProvider: true, savedVoiceProvider: true, carryDictation: true },
      memoryMark(true),
    );
    expect(mittrDictationOn(fake.config())).toBe(true);
    expect(net.calls.map((call) => `${call.method} ${call.path}`)).toEqual(['PUT /api/mittr/speech/key', 'POST /api/mittr/speech/carried']);
  });

  test('the mark lives in storage and a storage that throws reads as already applied', () => {
    const items = new Map<string, string>();
    const mark = storageFirstRunMark({ getItem: (key) => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value); } });
    expect(mark.applied()).toBe(false);
    mark.apply();
    expect(items.get(FIRST_RUN_MARK)).toBe('1');
    expect(mark.applied()).toBe(true);
    const broken = storageFirstRunMark({ getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(broken.applied()).toBe(true);
    expect(storageFirstRunMark(null).applied()).toBe(true);
  });
});

describe('what the server offers', () => {
  test('reads the speech offer and refuses an address that is not Mittr speech on this Mac', async () => {
    const offer = { offered: true, baseUrl: BASE_URL, model: 'mittr', voice: 'mittr', installed: { stt: true, openaiCompatible: false }, carryDictation: false };
    const good = createUpstreamSpeech({ config: fakeConfig().config, fetch: recordingFetch(() => new Response(JSON.stringify(offer))).fetch });
    expect(await good.readOffer()).toEqual(offer);
    const bad = createUpstreamSpeech({ config: fakeConfig().config, fetch: recordingFetch(() => new Response(JSON.stringify({ ...offer, baseUrl: 'http://api.example.test/v1' }))).fetch });
    expect(await bad.readOffer()).toBeNull();
  });

  test('the body a hosted runtime sends reads as not offered, not as a failure', async () => {
    const hosted = { offered: false, baseUrl: null, model: 'mittr', voice: 'mittr', installed: { stt: false, openaiCompatible: false }, carryDictation: false };
    const speech = createUpstreamSpeech({ config: fakeConfig().config, fetch: recordingFetch(() => new Response(JSON.stringify(hosted))).fetch });
    expect(await speech.readOffer()).toEqual(hosted);
    const missing = createUpstreamSpeech({ config: fakeConfig().config, fetch: recordingFetch(() => new Response(JSON.stringify({ ...hosted, offered: true }))).fetch });
    expect(await missing.readOffer()).toBeNull();
  });

  test('a local dictation model counts as installed only when the server says so', async () => {
    const installed = recordingFetch(() => new Response(JSON.stringify({ models: [{ id: 'a', installed: false }, { id: 'b', installed: true }] })));
    expect(await createUpstreamSpeech({ config: fakeConfig().config, fetch: installed.fetch }).readLocalModelInstalled()).toBe(true);
    expect(installed.calls[0]?.path).toBe('/api/dictation/status?provider=local');
    const none = recordingFetch(() => new Response(JSON.stringify({ models: [] })));
    expect(await createUpstreamSpeech({ config: fakeConfig().config, fetch: none.fetch }).readLocalModelInstalled()).toBe(false);
    const down = recordingFetch(() => new Response('down', { status: 503 }));
    expect(await createUpstreamSpeech({ config: fakeConfig().config, fetch: down.fetch }).readLocalModelInstalled()).toBeNull();
  });
});

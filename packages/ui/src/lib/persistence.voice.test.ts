import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import type { RuntimeAPIs, SettingsPayload } from '@/lib/api/types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { syncDesktopSettings } from './persistence';
import { switchRuntimeEndpoint } from './runtime-switch';

type VoiceConfigState = {
  sttProvider: string;
  voiceStepCap: number;
  voiceReplyMaxChars: number;
  dictationEnabled: boolean;
  settingsMessageStreamTransport: string;
  setSettingsMessageStreamTransport: (value: string) => void;
};

const values = new Map<string, string>();
if (typeof localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => { values.clear(); },
    },
    configurable: true,
    writable: true,
  });
}

let configState: VoiceConfigState;
const configStore = {
  getState: () => configState,
  setState: (partial: Partial<VoiceConfigState>) => {
    configState = { ...configState, ...partial };
  },
};

if (typeof window === 'undefined') {
  const target = new EventTarget();
  Object.defineProperty(globalThis, 'window', {
    value: {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
      setTimeout,
      clearTimeout,
    },
    configurable: true,
    writable: true,
  });
}
(window as unknown as { __zustand_config_store__: typeof configStore }).__zustand_config_store__ = configStore;

type StatusReply = { models: Array<{ id: string; installed: boolean }> } | 'fail';
let statusReply: StatusReply = { models: [{ id: 'parakeet', installed: false }] };
let statusCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes('/api/dictation/status')) {
    statusCalls += 1;
    if (statusReply === 'fail') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(statusReply), { headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;

let saved: Array<Partial<SettingsPayload>> = [];
let runtimeCounter = 0;
const syncWith = async (settings: SettingsPayload) => {
  runtimeCounter += 1;
  switchRuntimeEndpoint({ apiBaseUrl: `https://voice-${runtimeCounter}.example`, runtimeKey: `voice-${runtimeCounter}` });
  registerRuntimeAPIs({
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    settings: {
      load: async () => ({
        settings: { draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true, autoSaveEnabled: true, ...settings },
        source: 'web',
      }),
      save: async (changes: Partial<SettingsPayload>) => {
        saved.push(changes);
        return changes as SettingsPayload;
      },
    },
  } as unknown as RuntimeAPIs);
  await syncDesktopSettings();
};

beforeEach(() => {
  localStorage.clear();
  saved = [];
  statusCalls = 0;
  statusReply = { models: [{ id: 'parakeet', installed: false }] };
  configState = {
    sttProvider: 'local',
    voiceStepCap: 8,
    voiceReplyMaxChars: 8000,
    dictationEnabled: true,
    settingsMessageStreamTransport: 'auto',
    setSettingsMessageStreamTransport: (value: string) => {
      configState = { ...configState, settingsMessageStreamTransport: value };
    },
  };
});

afterAll(() => {
  globalThis.fetch = realFetch;
  registerRuntimeAPIs(null);
});

describe('voice settings from the desktop settings', () => {
  test('a fresh install with nothing saved and no local model gets Mittr, and it is saved', async () => {
    await syncWith({});
    expect(configState.sttProvider).toBe('mittr');
    expect(saved.some((changes) => changes.sttProvider === 'mittr')).toBe(true);
  });

  test('an install with a downloaded local model keeps local dictation', async () => {
    statusReply = { models: [{ id: 'parakeet', installed: true }] };
    await syncWith({});
    expect(configState.sttProvider).toBe('local');
    expect(saved.some((changes) => changes.sttProvider === 'local')).toBe(true);
  });

  test('an install with a stored local model keeps local dictation without asking the server', async () => {
    await syncWith({ sttLocalModel: 'whisper-base-int8' });
    expect(configState.sttProvider).toBe('local');
    expect(statusCalls).toBe(0);
  });

  test('when the local model check fails nothing changes and nothing is saved', async () => {
    statusReply = 'fail';
    configState.sttProvider = 'local';
    await syncWith({});
    expect(configState.sttProvider).toBe('local');
    expect(saved.some((changes) => 'sttProvider' in changes)).toBe(false);
  });

  test('a saved choice is never re-decided', async () => {
    statusReply = { models: [{ id: 'parakeet', installed: true }] };
    await syncWith({ sttProvider: 'mittr' });
    expect(configState.sttProvider).toBe('mittr');
    expect(statusCalls).toBe(0);
  });

  test('a saved dictation choice is kept', async () => {
    await syncWith({ sttProvider: 'local' });
    expect(configState.sttProvider).toBe('local');
    expect(localStorage.getItem('sttProvider')).toBe('local');
  });

  test('a saved Mittr choice is kept and mirrored', async () => {
    configState.sttProvider = 'openai-compatible';
    await syncWith({ sttProvider: 'mittr' });
    expect(configState.sttProvider).toBe('mittr');
    expect(localStorage.getItem('sttProvider')).toBe('mittr');
  });

  test('the voice assistant limits reach the config store', async () => {
    await syncWith({ voiceStepCap: 12, voiceReplyMaxChars: 20000 });
    expect(configState.voiceStepCap).toBe(12);
    expect(configState.voiceReplyMaxChars).toBe(20000);
  });

  test('limits omitted by the settings fall back to their defaults', async () => {
    configState.voiceStepCap = 15;
    configState.voiceReplyMaxChars = 12000;
    await syncWith({});
    expect(configState.voiceStepCap).toBe(8);
    expect(configState.voiceReplyMaxChars).toBe(8000);
  });
});

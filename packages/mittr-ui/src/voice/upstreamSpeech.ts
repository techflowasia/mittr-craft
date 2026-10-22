import { z } from 'zod';

import type { useConfigStore } from '../../../ui/src/stores/useConfigStore';
import type { VoiceFetch } from './voiceApi';

export const MITTR_SPEECH_MODEL = 'mittr';
export const MITTR_SPEECH_VOICE = 'mittr';
export const MITTR_SPEECH_PATH = '/mittr-speech/v1';
export const SPEECH_ENDPOINT = '/api/mittr/speech';
export const SPEECH_KEY_ENDPOINT = '/api/mittr/speech/key';
export const SPEECH_CARRIED_ENDPOINT = '/api/mittr/speech/carried';
export const LOCAL_DICTATION_STATUS_ENDPOINT = '/api/dictation/status';
export const FIRST_RUN_MARK = 'mittrcraft.speech.firstRunApplied';

const UPSTREAM_DICTATION_PROVIDER = 'local';
const UPSTREAM_READ_ALOUD_PROVIDER = 'browser';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

type ConfigState = ReturnType<typeof useConfigStore.getState>;

export type SpeechConfig = Pick<
  ConfigState,
  | 'sttProvider'
  | 'sttServerUrl'
  | 'voiceProvider'
  | 'openaiCompatibleUrl'
  | 'setSttProvider'
  | 'setSttServerUrl'
  | 'setSttModel'
  | 'setVoiceProvider'
  | 'setOpenaiCompatibleUrl'
  | 'setOpenaiCompatibleTtsModel'
  | 'setOpenaiCompatibleVoice'
  | 'setTtsChunkedMode'
  | 'refreshVoiceApiKeys'
>;

export type SpeechKind = 'stt' | 'openaiCompatible';

export function isMittrSpeechUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname) && parsed.pathname === MITTR_SPEECH_PATH;
}

export function mittrDictationOn(state: Pick<SpeechConfig, 'sttProvider' | 'sttServerUrl'>): boolean {
  return state.sttProvider === 'openai-compatible' && isMittrSpeechUrl(state.sttServerUrl);
}

export function mittrReadAloudOn(state: Pick<SpeechConfig, 'voiceProvider' | 'openaiCompatibleUrl'>): boolean {
  return state.voiceProvider === 'openai-compatible' && isMittrSpeechUrl(state.openaiCompatibleUrl);
}

const speechOfferFields = {
  model: z.string(),
  voice: z.string(),
  installed: z.object({ stt: z.boolean(), openaiCompatible: z.boolean() }),
  carryDictation: z.boolean(),
};

const speechOfferSchema = z.discriminatedUnion('offered', [
  z.object({ offered: z.literal(true), baseUrl: z.string().refine(isMittrSpeechUrl), ...speechOfferFields }),
  z.object({ offered: z.literal(false), baseUrl: z.string().nullable(), ...speechOfferFields }),
]);

export type SpeechOffer = z.infer<typeof speechOfferSchema>;

const localStatusSchema = z.object({ models: z.array(z.object({ installed: z.boolean() })) });

export interface FirstRunFacts {
  vscode: boolean;
  savedSttProvider: boolean;
  savedVoiceProvider: boolean;
  localModelSaved: boolean;
  localModelInstalled: boolean;
  carryDictation: boolean;
}

export interface FirstRunMark {
  applied(): boolean;
  apply(): void;
}

export interface UpstreamSpeechDeps {
  config: () => SpeechConfig;
  fetch: VoiceFetch;
}

export function usesMittrDictationAtFirstRun(facts: FirstRunFacts): boolean {
  return !facts.vscode && !facts.savedSttProvider && !facts.localModelSaved && !facts.localModelInstalled;
}

export function usesMittrReadAloudAtFirstRun(facts: FirstRunFacts): boolean {
  return !facts.vscode && !facts.savedVoiceProvider;
}

export function createUpstreamSpeech(deps: UpstreamSpeechDeps) {
  const putKey = async (kind: SpeechKind, installed: boolean): Promise<boolean> => {
    try {
      const res = await deps.fetch(SPEECH_KEY_ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(kind === 'stt' ? { stt: installed } : { openaiCompatible: installed }),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  const refreshKeys = async (): Promise<void> => {
    await deps.config().refreshVoiceApiKeys({ force: true });
  };

  const chooseMittrDictation = async (baseUrl: string): Promise<boolean> => {
    const config = deps.config();
    config.setSttProvider('openai-compatible');
    config.setSttServerUrl(baseUrl);
    config.setSttModel(MITTR_SPEECH_MODEL);
    const installed = await putKey('stt', true);
    await refreshKeys();
    return installed;
  };

  const chooseMittrReadAloud = async (baseUrl: string): Promise<boolean> => {
    const config = deps.config();
    config.setVoiceProvider('openai-compatible');
    config.setOpenaiCompatibleUrl(baseUrl);
    config.setOpenaiCompatibleTtsModel(MITTR_SPEECH_MODEL);
    config.setOpenaiCompatibleVoice(MITTR_SPEECH_VOICE);
    config.setTtsChunkedMode(true);
    const installed = await putKey('openaiCompatible', true);
    await refreshKeys();
    return installed;
  };

  const stopMittrDictation = async (): Promise<boolean> => {
    deps.config().setSttProvider(UPSTREAM_DICTATION_PROVIDER);
    const removed = await putKey('stt', false);
    await refreshKeys();
    return removed;
  };

  const stopMittrReadAloud = async (): Promise<boolean> => {
    deps.config().setVoiceProvider(UPSTREAM_READ_ALOUD_PROVIDER);
    const removed = await putKey('openaiCompatible', false);
    await refreshKeys();
    return removed;
  };

  const followPort = (baseUrl: string): void => {
    const config = deps.config();
    if (isMittrSpeechUrl(config.sttServerUrl) && config.sttServerUrl !== baseUrl) config.setSttServerUrl(baseUrl);
    if (isMittrSpeechUrl(config.openaiCompatibleUrl) && config.openaiCompatibleUrl !== baseUrl) config.setOpenaiCompatibleUrl(baseUrl);
  };

  const markCarried = async (): Promise<void> => {
    try {
      await deps.fetch(SPEECH_CARRIED_ENDPOINT, { method: 'POST' });
    } catch {
      return;
    }
  };

  const applyFirstRun = async (baseUrl: string, facts: FirstRunFacts, mark: FirstRunMark): Promise<void> => {
    if (facts.vscode) return;
    if (!mark.applied()) {
      mark.apply();
      if (usesMittrDictationAtFirstRun(facts)) await chooseMittrDictation(baseUrl);
      if (usesMittrReadAloudAtFirstRun(facts)) await chooseMittrReadAloud(baseUrl);
    }
    if (facts.carryDictation) {
      if (!mittrDictationOn(deps.config())) await chooseMittrDictation(baseUrl);
      await markCarried();
    }
  };

  const readOffer = async (): Promise<SpeechOffer | null> => {
    try {
      const res = await deps.fetch(SPEECH_ENDPOINT, { method: 'GET' });
      if (!res.ok) return null;
      const parsed = speechOfferSchema.safeParse(await res.json().catch(() => null));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  const readLocalModelInstalled = async (): Promise<boolean | null> => {
    try {
      const res = await deps.fetch(`${LOCAL_DICTATION_STATUS_ENDPOINT}?provider=local`, { method: 'GET' });
      if (!res.ok) return null;
      const parsed = localStatusSchema.safeParse(await res.json().catch(() => null));
      return parsed.success ? parsed.data.models.some((model) => model.installed) : null;
    } catch {
      return null;
    }
  };

  return {
    chooseMittrDictation,
    chooseMittrReadAloud,
    stopMittrDictation,
    stopMittrReadAloud,
    followPort,
    applyFirstRun,
    readOffer,
    readLocalModelInstalled,
  };
}

export type UpstreamSpeech = ReturnType<typeof createUpstreamSpeech>;

export function storageFirstRunMark(storage: Pick<Storage, 'getItem' | 'setItem'> | null): FirstRunMark {
  return {
    applied: () => {
      if (!storage) return true;
      try {
        return storage.getItem(FIRST_RUN_MARK) === '1';
      } catch {
        return true;
      }
    },
    apply: () => {
      try {
        storage?.setItem(FIRST_RUN_MARK, '1');
      } catch {
        return;
      }
    },
  };
}

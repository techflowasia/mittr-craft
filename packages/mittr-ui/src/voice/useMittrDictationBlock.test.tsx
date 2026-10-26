import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from '../../../ui/node_modules/happy-dom';

import { dictationBlockOf } from './useMittrDictationBlock';
import type { VoiceReadiness } from './voiceApi';

const READY: VoiceReadiness = { listen: true, speak: true, voice: true, signedIn: true, here: true, voiceSilenceMs: 900, reason: null };
const BASE_URL = 'http://127.0.0.1:57188/mittr-speech/v1';

describe('the dictation block', () => {
  test('nothing is blocked when Mittr is not the voice input', () => {
    expect(dictationBlockOf({ mittrOn: false, sttBlockedUntil: '2099-01-01T00:00:00.000Z', readiness: { ...READY, listen: false } })).toEqual({ blocked: false });
  });

  test('the microphone is disabled with the reset time while voice input is used up', () => {
    const block = dictationBlockOf({ mittrOn: true, sttBlockedUntil: '2026-10-26T17:00:00.000Z', readiness: READY });
    expect(block.blocked).toBe(true);
    expect(block.reason?.startsWith('Voice input is out of quota until Tue 27 Oct')).toBe(true);
  });

  test('a not-configured platform disables the microphone with the admin line', () => {
    expect(dictationBlockOf({ mittrOn: true, sttBlockedUntil: null, readiness: { ...READY, listen: false, reason: 'not_configured' } })).toEqual({
      blocked: true,
      reason: 'Your Mittr admin has not set up speech models yet.',
    });
    expect(dictationBlockOf({ mittrOn: true, sttBlockedUntil: null, readiness: { ...READY, listen: false, reason: null } }).reason).toBe('Your Mittr admin has not set up speech models yet.');
    expect(dictationBlockOf({ mittrOn: true, sttBlockedUntil: null, readiness: { ...READY, listen: false, reason: 'not_signed_in' } }).reason).toBe('Sign in to Mittr to use it.');
    expect(dictationBlockOf({ mittrOn: true, sttBlockedUntil: null, readiness: { ...READY, listen: false, reason: 'unreachable' } }).reason).toBe('The Mittr platform cannot be reached right now.');
  });

  test('unknown readiness blocks nothing', () => {
    expect(dictationBlockOf({ mittrOn: true, sttBlockedUntil: null, readiness: null })).toEqual({ blocked: false });
  });
});

const browser = new Window({ url: 'http://localhost/' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

afterAll(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('the dictation block hook', () => {
  afterEach(async () => {
    const { speechQuotaStore } = await import('./speechQuotaStore');
    speechQuotaStore.reset();
  });

  test('the microphone is disabled with the reset time and re-enabled when the block lifts', async () => {
    const { createRoot } = await import('react-dom/client');
    const { useConfigStore } = await import('../../../ui/src/stores/useConfigStore');
    const { speechQuotaStore } = await import('./speechQuotaStore');
    const { useMittrDictationBlock } = await import('./useMittrDictationBlock');
    useConfigStore.setState({ sttProvider: 'openai-compatible', sttServerUrl: BASE_URL });
    const seen: boolean[] = [];
    function Probe(): null {
      seen.push(useMittrDictationBlock().blocked);
      return null;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<Probe />));
    await act(async () => {
      speechQuotaStore.block('stt', new Date(Date.now() + 40).toISOString());
    });
    expect(seen.at(-1)).toBe(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(seen.at(-1)).toBe(false);
    await act(async () => root.unmount());
  });
});

import { afterEach, describe, expect, test } from 'bun:test';

import { DEFAULT_LOCALE } from '../../../ui/src/lib/i18n/runtime';
import { useI18nStore } from '../../../ui/src/lib/i18n/store';
import { mittrEn } from '../strings/mittr.en';
import { mittrT } from '../strings/mittrT';

const waitForLocale = async (locale: string) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = useI18nStore.getState();
    if (state.locale === locale && state.loadingLocale === null) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`the UI never settled on ${locale}`);
};

afterEach(() => {
  useI18nStore.getState().setLocale(DEFAULT_LOCALE);
});

describe('voice strings', () => {
  test('Mittr strings are English in Japanese', async () => {
    useI18nStore.getState().setLocale('ja');
    await waitForLocale('ja');
    expect(mittrT('mittr.voice.talk.start')).toBe('Talk');
    expect(mittrT('mittr.voice.talk.running', { label: 'Opening Chrome' })).toBe('Working: Opening Chrome');
    expect(mittrT('mittr.speech.sttExhausted', { when: 'Tue 27 Oct, 00:00' })).toBe('Voice input is out of quota until Tue 27 Oct, 00:00');
    expect(mittrT('mittr.voice.accountChanged')).toBe('The Mittr account changed.');
  });

  test('the 1.22 voice and speech quota text carries over unchanged', () => {
    expect(mittrEn['mittr.voice.settings.mittr.reason.not_signed_in']).toBe('Sign in to Mittr to use it.');
    expect(mittrEn['mittr.voice.settings.mittr.reason.not_configured']).toBe('Your Mittr admin has not set up speech models yet.');
    expect(mittrEn['mittr.voice.settings.mittr.reason.unreachable']).toBe('The Mittr platform cannot be reached right now.');
    expect(mittrEn['mittr.speech.ttsExhausted']).toBe('Spoken replies are out of quota this week — answering in text');
    expect(mittrEn['mittr.speech.kind.stt']).toBe('Voice input');
    expect(mittrEn['mittr.speech.kind.tts']).toBe('Spoken replies');
  });
});

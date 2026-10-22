import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '../../../ui/src/lib/i18n';
import { DEFAULT_LOCALE } from '../../../ui/src/lib/i18n/runtime';
import { useI18nStore } from '../../../ui/src/lib/i18n/store';
import { MittrErrorBoundary } from '../MittrErrorBoundary';
import { mittrT } from '../strings/mittrT';
import { MittrVoiceSectionView, MittrVoiceSettingsItem, type VoiceSettingsActions } from './MittrVoiceSection';
import type { SpeechOffer } from './upstreamSpeech';
import type { VoiceReadiness } from './voiceApi';
import type { VoiceSettingsControllerState, VoiceSettingsLoad } from './voiceSettingsController';

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

const noop = () => {};

const actions: VoiceSettingsActions = {
  retry: noop,
  setDictation: noop,
  setReadAloud: noop,
  setStepCap: noop,
  setReplyMaxChars: noop,
  preview: noop,
};

const OFFER: SpeechOffer = {
  offered: true,
  baseUrl: 'http://127.0.0.1:4100/mittr-speech/v1',
  model: 'mittr',
  voice: 'mittr',
  installed: { stt: false, openaiCompatible: false },
  carryDictation: false,
};

const READY: VoiceReadiness = { listen: true, speak: true, voice: true, signedIn: true, here: true, voiceSilenceMs: 900, reason: null };

const loaded = (change: { offer?: Partial<SpeechOffer>; canChange?: boolean; readiness?: Partial<VoiceReadiness> | null } = {}): VoiceSettingsLoad => ({
  status: 'ready',
  offer: { ...OFFER, ...change.offer },
  limits: change.offer?.offered === false ? null : { stepCap: 8, replyMaxChars: 8000, canChange: change.canChange ?? true },
  readiness: change.readiness === null ? null : { ...READY, ...change.readiness },
});

const view = (load: VoiceSettingsLoad, { dictationOn = false, readAloudOn = false, previewing = false } = {}) => {
  const state: VoiceSettingsControllerState = { load, previewing };
  return renderToStaticMarkup(
    <I18nProvider><MittrVoiceSectionView state={state} dictationOn={dictationOn} readAloudOn={readAloudOn} actions={actions} /></I18nProvider>,
  );
};

const PREVIEW = `>${mittrT('mittr.voice.settings.preview')}<`;

describe('MittrCraft voice section', () => {
  test('the section is titled MittrCraft voice and carries both switches, the preview and both limits', () => {
    const html = view(loaded(), { dictationOn: true });
    expect(html).toContain('>MittrCraft voice</h2>');
    expect(html).toContain(`>${mittrT('mittr.voice.settings.dictation.label')}</span>`);
    expect(html).toContain(`>${mittrT('mittr.voice.settings.readAloud.label')}</span>`);
    expect(html).toContain(mittrT('mittr.voice.settings.mittr.description'));
    expect(html).toContain(mittrT('mittr.voice.settings.keyNote'));
    expect(html).toContain(PREVIEW);
    expect(html).toContain(`>${mittrT('mittr.voice.settings.assistant.stepCap')}<`);
    expect(html).toContain(`>${mittrT('mittr.voice.settings.assistant.replyMaxChars')}<`);
    expect(html).toContain('value="8"');
    expect(html).toContain('value="8000"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(mittrT('mittr.voice.settings.keyNote')).toContain('another speech server');
  });

  test('a hosted runtime renders no Mittr speech switch', () => {
    expect(view(loaded({ offer: { offered: false } }))).toBe('');
    expect(view({ status: 'loading' })).toBe('');
  });

  test('the reason line shows when the platform has no speech models', () => {
    const html = view(loaded({ readiness: { listen: false, speak: false, voice: false, reason: 'not_configured' } }));
    expect(html).toContain('role="status"');
    expect(html).toContain(mittrT('mittr.voice.settings.mittr.reason.not_configured'));
    expect(view(loaded({ readiness: { signedIn: false, reason: 'not_signed_in' } }))).toContain(mittrT('mittr.voice.settings.mittr.reason.not_signed_in'));
    expect(view(loaded({ readiness: { reason: 'unreachable' } }))).toContain(mittrT('mittr.voice.settings.mittr.reason.unreachable'));
    expect(view(loaded())).not.toContain('role="status"');
    expect(view(loaded({ readiness: null }))).not.toContain('role="status"');
  });

  test('preview is hidden while speaking is not ready', () => {
    expect(view(loaded({ readiness: { speak: false } }))).not.toContain(PREVIEW);
    expect(view(loaded({ readiness: null }))).not.toContain(PREVIEW);
    expect(view(loaded())).toContain(PREVIEW);
  });

  test('a preview that is playing offers to stop', () => {
    const html = view(loaded(), { previewing: true });
    expect(html).toContain(`>${mittrT('mittr.voice.settings.previewStop')}<`);
    expect(html).not.toContain(PREVIEW);
  });

  test('a client that is not this Mac sees the values and one line instead of controls', () => {
    const html = view(loaded({ canChange: false }));
    expect(html).toContain('>MittrCraft voice</h2>');
    expect(html).toContain(mittrT('mittr.voice.settings.changeOnThisMac'));
    expect(html).toContain('>8<');
    expect(html).toContain('>8000<');
    expect(html).not.toContain('aria-pressed');
    expect(html).not.toContain('<input');
    expect(html).not.toContain(PREVIEW);
  });

  test('a load failure shows its reason with a way to try again', () => {
    const html = view({ status: 'error', error: 'Could not load the MittrCraft voice settings' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Could not load the MittrCraft voice settings');
    expect(html).toContain(`>${mittrT('mittr.voice.settings.actions.retry')}<`);
  });

  test('Mittr strings are English in Japanese', async () => {
    useI18nStore.getState().setLocale('ja');
    await waitForLocale('ja');
    const html = view(loaded({ readiness: { reason: 'not_configured', speak: false } }), { readAloudOn: true });
    expect(html).toContain('>MittrCraft voice</h2>');
    expect(html).toContain(mittrT('mittr.voice.settings.dictation.label'));
    expect(html).toContain('Your Mittr admin has not set up speech models yet.');
    expect(html).toContain('Most actions per spoken request');
  });

  test('the settings item is guarded so a failure inside it cannot take the page down', () => {
    const element = MittrVoiceSettingsItem();
    expect(React.isValidElement(element) && element.type).toBe(MittrErrorBoundary);
  });
});

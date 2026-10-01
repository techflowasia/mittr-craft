import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { TalkButton } from './TalkButton';
import { I18nProvider } from '@/lib/i18n';
import type { VoiceReadiness } from '@/lib/voice-assistant/turn';

const ready: VoiceReadiness = { listen: true, speak: true, voice: true, signedIn: true, voiceSilenceMs: 900, reason: null };

const render = (
  readiness: VoiceReadiness | null,
  phase: 'idle' | 'starting' | 'listening' = 'idle',
  voiceInputBlockedUntil: string | null = null,
) =>
  renderToStaticMarkup(
    <I18nProvider>
      <TalkButton readiness={readiness} phase={phase} onToggle={() => {}} voiceInputBlockedUntil={voiceInputBlockedUntil} />
    </I18nProvider>,
  );

describe('TalkButton', () => {
  test('shows a labelled Talk control when listen, speak and voice are ready and the person is signed in', () => {
    const html = render(ready);
    expect(html).toContain('<button');
    expect(html).toContain('aria-label="Talk"');
    expect(html).not.toContain('aria-pressed');
  });

  test('is hidden when readiness is unknown', () => {
    expect(render(null)).toBe('');
  });

  for (const part of ['listen', 'speak', 'voice'] as const) {
    test(`is hidden when ${part} is not ready`, () => {
      expect(render({ ...ready, [part]: false })).toBe('');
    });
  }

  test('is hidden when the person is not signed in', () => {
    expect(render({ ...ready, signedIn: false, reason: 'not_signed_in' })).toBe('');
  });

  test('while a conversation is open it becomes the End control', () => {
    const html = render(ready, 'listening');
    expect(html).toContain('aria-label="End conversation"');
    expect(html).not.toContain('aria-pressed');
  });

  test('uses the sound-wave icon, not the dictation microphone', () => {
    const html = render(ready);
    expect(html).toContain('voiceprint');
    expect(html).not.toContain('#oc-icon-mic"');
  });

  test('says it is busy while the microphone starts', () => {
    expect(render(ready, 'starting')).toContain('aria-busy="true"');
  });

  test('is disabled and says until when while voice input is out of quota', () => {
    const html = render(ready, 'idle', '2026-10-04T17:00:00.000Z');
    expect(html).toContain('disabled=""');
    expect(html).toContain('Voice input is out of quota until');
    expect(html).toContain('Oct');
  });

  test('still lets an open conversation be ended while voice input is out of quota', () => {
    const html = render(ready, 'listening', '2026-10-04T17:00:00.000Z');
    expect(html).toContain('aria-label="End conversation"');
    expect(html).not.toContain('disabled=""');
  });
});

import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { TalkButton } from './TalkButton';
import { I18nProvider } from '@/lib/i18n';
import type { VoiceReadiness } from '@/lib/voice-assistant/turn';

const ready: VoiceReadiness = { listen: true, speak: true, voice: true, signedIn: true, voiceSilenceMs: 900, reason: null };

const render = (readiness: VoiceReadiness | null, phase: 'idle' | 'starting' | 'listening' = 'idle') =>
  renderToStaticMarkup(
    <I18nProvider>
      <TalkButton readiness={readiness} phase={phase} onToggle={() => {}} />
    </I18nProvider>,
  );

describe('TalkButton', () => {
  test('shows a labelled Talk control when listen, speak and voice are ready and the person is signed in', () => {
    const html = render(ready);
    expect(html).toContain('<button');
    expect(html).toContain('aria-label="Talk"');
    expect(html).toContain('aria-pressed="false"');
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
    expect(html).toContain('aria-pressed="true"');
  });

  test('says it is busy while the microphone starts', () => {
    expect(render(ready, 'starting')).toContain('aria-busy="true"');
  });
});

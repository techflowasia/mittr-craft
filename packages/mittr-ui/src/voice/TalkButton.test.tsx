import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TalkButton } from './TalkButton';
import type { VoiceReadiness } from './voiceApi';

const ready: VoiceReadiness = { listen: true, speak: true, voice: true, signedIn: true, here: true, voiceSilenceMs: 900, reason: null };

const render = (
  readiness: VoiceReadiness | null,
  phase: 'idle' | 'starting' | 'listening' = 'idle',
  voiceInputBlockedUntil: string | null = null,
) => renderToStaticMarkup(<TalkButton readiness={readiness} phase={phase} onToggle={() => {}} voiceInputBlockedUntil={voiceInputBlockedUntil} />);

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

  test('a hosted runtime renders no Talk button', () => {
    expect(render({ ...ready, here: false })).toBe('');
  });

  test('while a conversation is open it becomes the End control', () => {
    const html = render(ready, 'listening');
    expect(html).toContain('aria-label="End conversation"');
    expect(html).not.toContain('aria-pressed');
  });

  test('uses the sound-wave icon, not the dictation microphone', () => {
    const html = render(ready);
    expect(html).toContain('data-mittr-icon="talk"');
    expect(html).not.toContain('#oc-mic"');
  });

  test('says it is busy while the microphone starts', () => {
    const html = render(ready, 'starting');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('#oc-loader-4');
  });

  test('Talk is disabled with the reset time while voice input is used up', () => {
    const html = render(ready, 'idle', '2026-10-26T17:00:00.000Z');
    expect(html).toContain('disabled=""');
    expect(html).toContain('Voice input is out of quota until Tue 27 Oct');
  });

  test('still lets an open conversation be ended while voice input is out of quota', () => {
    const html = render(ready, 'listening', '2026-10-04T17:00:00.000Z');
    expect(html).toContain('aria-label="End conversation"');
    expect(html).not.toContain('disabled=""');
  });
});

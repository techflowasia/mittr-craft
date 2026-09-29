import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { VoiceBar } from './VoiceBar';
import { I18nProvider } from '@/lib/i18n';
import type { VoiceSnapshot } from '@/lib/voice-assistant/session';

const snapshot = (patch: Partial<VoiceSnapshot> = {}): VoiceSnapshot => ({
  phase: 'listening',
  hearing: false,
  transcript: [],
  running: null,
  error: null,
  ...patch,
});

const render = (value: VoiceSnapshot) =>
  renderToStaticMarkup(
    <I18nProvider>
      <VoiceBar snapshot={value} onEnd={() => {}} onSignIn={() => {}} />
    </I18nProvider>,
  );

describe('VoiceBar', () => {
  test('renders nothing while idle', () => {
    expect(render(snapshot({ phase: 'idle' }))).toBe('');
  });

  test('is a labelled region with a live state and an End button', () => {
    const html = render(snapshot());
    expect(html).toContain('aria-label="Voice assistant"');
    expect(html).toContain('role="status"');
    expect(html).toContain('Listening…');
    expect(html).toContain('End conversation');
  });

  for (const [phase, label] of [
    ['thinking', 'Thinking…'],
    ['speaking', 'Speaking…'],
  ] as const) {
    test(`shows ${label} while ${phase}`, () => {
      expect(render(snapshot({ phase }))).toContain(label);
    });
  }

  test('shows the transcript as You and Assistant lines in a log', () => {
    const html = render(
      snapshot({
        transcript: [
          { id: 1, role: 'user', text: 'open chrome' },
          { id: 2, role: 'assistant', text: 'Opening Chrome.' },
        ],
      }),
    );
    expect(html).toContain('role="log"');
    expect(html).toContain('You');
    expect(html).toContain('open chrome');
    expect(html).toContain('Assistant');
    expect(html).toContain('Opening Chrome.');
  });

  test('shows what the assistant is doing', () => {
    expect(render(snapshot({ phase: 'thinking', running: 'Reading the page' }))).toContain('Working: Reading the page');
  });

  test('says when the person is not signed in and offers sign-in', () => {
    const html = render(snapshot({ error: 'voice.talk.error.notSignedIn' }));
    expect(html).toContain('Sign in to Mittr to talk to the assistant.');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Sign in');
  });
});

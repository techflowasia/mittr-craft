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
    expect(html).not.toContain('role="log" aria-live="polite"');
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

describe('VoiceBar announcements', () => {
  const lines = [
    { id: 1, role: 'user' as const, text: 'open chrome' },
    { id: 2, role: 'assistant' as const, text: 'Opening Chr' },
  ];
  const announced = (html: string) => /data-voice-announce="true"[^>]*>([^<]*)</.exec(html)?.[1] ?? '';

  test('a reply still arriving is not announced word by word', () => {
    expect(announced(render(snapshot({ phase: 'speaking', transcript: lines })))).toBe('');
  });

  test('a finished reply is announced once the assistant is listening again', () => {
    expect(announced(render(snapshot({ phase: 'listening', transcript: lines })))).toBe('Assistant: Opening Chr');
  });

  test('what the person said is announced while the assistant thinks', () => {
    expect(announced(render(snapshot({ phase: 'thinking', transcript: [lines[0]] })))).toBe('You: open chrome');
  });
});

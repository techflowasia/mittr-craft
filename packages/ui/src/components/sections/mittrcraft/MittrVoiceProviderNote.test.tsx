import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { dict } from '@/lib/i18n/messages/en';
import { MittrVoiceProviderNote } from './MittrVoiceProviderNote';
import type { MittrVoiceReason } from '@/lib/voice/mittrVoice';

const note = (reason: MittrVoiceReason | null) => renderToStaticMarkup(
  <I18nProvider>
    <MittrVoiceProviderNote reason={reason} />
  </I18nProvider>,
);

describe('MittrVoiceProviderNote', () => {
  test('shows each readiness reason as a status line', () => {
    expect(note('not_signed_in')).toContain(dict['settings.voice.mittr.reason.not_signed_in']);
    expect(note('not_configured')).toContain(dict['settings.voice.mittr.reason.not_configured']);
    expect(note('unreachable')).toContain(dict['settings.voice.mittr.reason.unreachable']);
    expect(note('unreachable')).toContain('role="status"');
  });

  test('stays quiet when Mittr is ready', () => {
    expect(note(null)).toBe('');
  });
});

import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { QuotaMeView, type QuotaMeState } from './MittrQuotaSettings';
import { I18nProvider } from '@/lib/i18n';

const render = (state: QuotaMeState) =>
  renderToStaticMarkup(
    <I18nProvider>
      <QuotaMeView state={state} onReload={() => {}} />
    </I18nProvider>,
  );

const week = {
  weekStart: '2026-09-27T17:00:00.000Z',
  resetsAt: '2026-10-04T17:00:00.000Z',
};

describe('QuotaMeView', () => {
  test('shows a bar per model with its units and when the week resets', () => {
    const html = render({
      status: 'ok',
      quota: {
        ...week,
        lines: [
          { modelKey: 'mittr-2', kind: 'chat', label: 'MITTR 2.0', used: 250000, limit: 500000 },
          { modelKey: 'asr', kind: 'stt', label: 'Voice', used: 120, limit: 600 },
          { modelKey: 'say', kind: 'tts', label: 'Speech', used: 5000, limit: 5000 },
        ],
      },
    });
    expect(html).toContain('This week&#x27;s quota');
    expect(html).toContain('data-settings-item="sessions.mittrQuota"');
    expect(html).toContain('Resets ');
    expect(html).toContain('Oct');
    expect(html).toContain('MITTR 2.0');
    expect(html).toContain('250,000 of 500,000 tokens');
    expect(html).toContain('120 of 600 s');
    expect(html).toContain('5,000 of 5,000 chars');
    expect(html.match(/role="progressbar"/g)).toHaveLength(3);
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain('aria-valuenow="100"');
  });

  test('says when no weekly limit applies', () => {
    expect(render({ status: 'ok', quota: { ...week, lines: [] } })).toContain('No weekly limits apply to you.');
  });

  test('tells signed out, offline and failed apart instead of showing an empty week', () => {
    expect(render({ status: 'not_signed_in' })).toContain('Sign in to Mittr to see your quota.');
    expect(render({ status: 'unreachable' })).toContain('The Mittr platform cannot be reached right now.');
    expect(render({ status: 'failed' })).toContain('Could not load your quota.');
    expect(render({ status: 'loading' })).toContain('Loading this week’s quota…');
  });

  test('stays out of the way on a platform without quotas', () => {
    expect(render({ status: 'not_available' })).toBe('');
  });
});

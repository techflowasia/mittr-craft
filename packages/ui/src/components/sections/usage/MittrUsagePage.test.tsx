import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { QuotaMeState } from '@/lib/mittr-quota/quota-me-store';

mock.module('@/hooks/useProviderLogo', () => ({
  useProviderLogo: () => ({ src: null, onError: () => {}, hasLogo: false }),
}));

const { MittrQuotaView } = await import('./MittrUsagePage');

const render = (state: QuotaMeState) =>
  renderToStaticMarkup(
    <I18nProvider>
      <MittrQuotaView state={state} onReload={() => {}} />
    </I18nProvider>,
  );

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

const week = { weekStart: '2026-09-27T17:00:00.000Z', resetsAt: '2026-10-04T17:00:00.000Z' };

describe('MittrQuotaView', () => {
  const html = render({
    status: 'ok',
    quota: {
      ...week,
      lines: [
        { modelKey: 'idle', kind: 'chat', label: 'MITTR 1.0 fast', used: 0, limit: 50_000_000 },
        { modelKey: 'm:abc', kind: 'chat', label: '', labelKey: 'quota.role.decision', used: 24_737, limit: 50_000_000 },
        {
          modelKey: 'mittr-2', kind: 'chat', label: 'MITTR 2.0', used: 500_000, limit: 500_000,
          agents: ['General Assistant', 'Writer', 'Reviewer', 'Planner', 'Tester', 'Designer'].map((label) => ({ key: label, label })),
        },
        { modelKey: 'asr', kind: 'stt', label: 'Voice', used: 600, limit: 36_000 },
        { modelKey: 'say', kind: 'tts', label: 'Speech', used: 5_000, limit: 1_000_000 },
      ],
    },
  });
  const body = text(html);

  test('is the Mittr usage page with the search anchor and the reset time', () => {
    expect(body).toContain('Mittr Usage');
    expect(body).toContain("This week's quota");
    expect(html).toContain('data-settings-item="sessions.mittrQuota"');
    expect(body).toContain('Resets ');
  });

  test('says what is left of the limit, the bar and what was used, in each unit', () => {
    expect(body).toContain('49,975,263 left of 50,000,000 tokens');
    expect(body).toContain('Used 24,737 tokens');
    expect(body).toContain('9 h 50 min left of 10 h');
    expect(body).toContain('Used 10 min');
    expect(body).toContain('995,000 left of 1,000,000 chars');
    expect(body).not.toContain(' of 500,000 tokens used');
    expect(html.match(/role="progressbar"/g)).toHaveLength(5);
    expect(html).toContain('aria-label="MITTR 2.0 0 left of 500,000 tokens"');
  });

  test('names system models from their role and lists who uses a model', () => {
    expect(body).toContain('System decision model (Jev)');
    expect(body).toContain('Used by: General Assistant, Writer, Reviewer, Planner +2');
  });

  test('groups by kind under one heading each, with used lines first and no per-row kind tag', () => {
    expect(body.match(/ Chat /g)).toHaveLength(1);
    expect(body.indexOf('Voice input')).toBeGreaterThan(body.indexOf('MITTR 1.0 fast'));
    expect(body.indexOf('MITTR 2.0')).toBeLessThan(body.indexOf('System decision model'));
    expect(body.indexOf('System decision model')).toBeLessThan(body.indexOf('MITTR 1.0 fast'));
  });

  test('tells signed out, offline, failed and loading apart', () => {
    expect(text(render({ status: 'not_signed_in' }))).toContain('Sign in to Mittr to see your quota.');
    expect(text(render({ status: 'unreachable' }))).toContain('The Mittr platform cannot be reached right now.');
    expect(text(render({ status: 'failed' }))).toContain('Could not load your quota.');
    expect(render({ status: 'loading' })).toContain('Loading this week’s quota…');
    expect(text(render({ status: 'ok', quota: { ...week, lines: [] } }))).toContain('No model is available to you this week');
  });
});

import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { formatMessage, type I18nKey, type I18nParams } from '@/lib/i18n';
import { dict as en } from '@/lib/i18n/messages/en';
import type { QuotaAgentStatus } from '@/lib/mittr-quota/quota-me';

mock.module('@/hooks/useProviderLogo', () => ({
  useProviderLogo: () => ({ src: null, onError: () => {}, hasLogo: false }),
}));

const { mittrAgentEntryStatus } = await import('./mittrAgentStatus');
const { ModelPickerList } = await import('./ModelPickerList');

const t = (key: I18nKey, params?: I18nParams) => formatMessage(en, key, params);
const base = { modelKey: 'm', left: 10, limit: 100, resetsAt: '2026-10-04T17:00:00.000Z' };
const status = (over: Partial<QuotaAgentStatus>): QuotaAgentStatus => ({ ...base, state: 'ok', ...over });

describe('Mittr agent status in the model picker', () => {
  test('shows nothing for an agent with room left', () => {
    expect(mittrAgentEntryStatus(status({ state: 'ok' }), 'General Assistant', t, 'en-US')).toBeNull();
    expect(mittrAgentEntryStatus(undefined, 'General Assistant', t, 'en-US')).toBeNull();
  });

  test('blocks an agent that is out of quota and says when it is back', () => {
    const out = mittrAgentEntryStatus(status({ state: 'out', left: 0 }), 'General Assistant', t, 'en-US');
    expect(out?.blocked).toBe(true);
    expect(out?.pill).toBe('Out of quota');
    expect(out?.title.startsWith('General Assistant is out of quota for this week, back ')).toBe(true);
  });

  test('keeps an agent on a backup model selectable and names the backup', () => {
    const backup = mittrAgentEntryStatus(status({ state: 'substitute', substituteLabel: 'MITTR 1.0 fast' }), 'Writer', t, 'en-US');
    expect(backup).toEqual({
      blocked: false,
      tone: 'neutral',
      pill: 'Using a backup model',
      title: "Writer's own quota is used up, so MITTR 1.0 fast answers instead",
    });
    expect(mittrAgentEntryStatus(status({ state: 'substitute' }), 'Writer', t, 'en-US')?.title)
      .toBe("Writer's own quota is used up, so a backup model answers instead");
  });

  test('shows how much is left when an agent is near its limit', () => {
    const near = mittrAgentEntryStatus(status({ state: 'near', percentLeft: 12 }), 'Writer', t, 'en-US');
    expect(near).toEqual({ blocked: false, tone: 'near', pill: '12% left', title: "Writer has 12% of this week's quota left" });
  });

  test('renders the pill on the row and makes an out-of-quota agent unselectable', () => {
    const html = renderToStaticMarkup(
      <ModelPickerList
        providers={[{
          id: 'mittr',
          name: 'Mittr',
          models: [{ id: 'assistant', name: 'General Assistant' }, { id: 'writer', name: 'Writer' }],
        }]}
        favoriteModels={[]}
        recentModels={[]}
        modelsMetadata={new Map()}
        searchQuery=""
        onSearchQueryChange={() => {}}
        onSelect={() => {}}
        labels={{ searchPlaceholder: 'Search', noResults: 'None', favorites: 'Favorites', recent: 'Recent', keyboardHint: '' }}
        entryStatus={(entry) => entry.modelID === 'assistant'
          ? mittrAgentEntryStatus(status({ state: 'out', left: 0 }), 'General Assistant', t, 'en-US')
          : null}
      />,
    );
    const rows = html.split('role="option"').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('aria-disabled="true"');
    expect(rows[0]).toContain('Out of quota');
    expect(rows[0]).toContain('title="General Assistant is out of quota for this week, back ');
    expect(rows[1]).not.toContain('aria-disabled');
    expect(rows[1]).not.toContain('data-model-status');
  });
});

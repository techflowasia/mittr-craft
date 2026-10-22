import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '../../../ui/src/lib/i18n';
import { mittrT } from '../strings/mittrT';
import { SuggestionStyleSectionView } from './SuggestionStyleSection';
import type { SuggestionStyleState } from './suggestionStyleController';

const noop = () => {};

const view = (state: SuggestionStyleState) => renderToStaticMarkup(
  <I18nProvider>
    <SuggestionStyleSectionView state={state} onChoose={noop} onRetry={noop} />
  </I18nProvider>,
);

const escaped = (text: string) => text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');

const optionTags = (html: string) => [...html.matchAll(/<div[^>]*role="button"[^>]*>/g)].map((match) => match[0]);

describe('SuggestionStyleSectionView', () => {
  test('a two-option choice with the MittrCraft default first and chosen', () => {
    const html = view({ status: 'ready', suggestionStyle: 'next-step', canChange: true, saving: false });
    expect(html).toContain(escaped(mittrT('mittr.chat.suggestions.title')));
    expect(html).toContain('role="radiogroup"');
    const nextStep = html.indexOf(escaped(mittrT('mittr.chat.suggestions.nextStep')));
    const unfinished = html.indexOf(escaped(mittrT('mittr.chat.suggestions.unfinishedOnly')));
    expect(nextStep).toBeGreaterThan(-1);
    expect(unfinished).toBeGreaterThan(nextStep);
    const tags = optionTags(html);
    expect(tags.length).toBe(2);
    expect(tags[0]).toContain('aria-pressed="true"');
    expect(tags[1]).toContain('aria-pressed="false"');
  });

  test('the other choice shows as chosen', () => {
    const tags = optionTags(view({ status: 'ready', suggestionStyle: 'unfinished-only', canChange: true, saving: false }));
    expect(tags[0]).toContain('aria-pressed="false"');
    expect(tags[1]).toContain('aria-pressed="true"');
  });

  test('while saving, or away from this Mac, the choice cannot be pressed', () => {
    for (const html of [
      view({ status: 'ready', suggestionStyle: 'next-step', canChange: true, saving: true }),
      view({ status: 'ready', suggestionStyle: 'next-step', canChange: false, saving: false }),
    ]) {
      for (const tag of optionTags(html)) expect(tag).toContain('aria-disabled="true"');
    }
    expect(view({ status: 'ready', suggestionStyle: 'next-step', canChange: false, saving: false })).toContain(escaped(mittrT('mittr.chat.suggestions.changeOnThisMac')));
  });

  test('loading shows nothing and a failed load shows why with a retry', () => {
    expect(view({ status: 'loading' })).toBe('');
    const html = view({ status: 'error', error: 'Could not read the suggestion setting' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Could not read the suggestion setting');
    expect(html).toContain(escaped(mittrT('mittr.chat.suggestions.retry')));
  });
});

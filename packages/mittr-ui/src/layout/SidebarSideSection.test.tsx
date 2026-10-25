import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '../../../ui/src/lib/i18n';
import { mittrT } from '../strings/mittrT';
import { SidebarSideSectionView } from './SidebarSideSection';
import type { SidebarSideState } from './sidebarSideStore';

const noop = () => {};

const view = (state: SidebarSideState) => renderToStaticMarkup(
  <I18nProvider>
    <SidebarSideSectionView state={state} onChoose={noop} onRetry={noop} />
  </I18nProvider>,
);

const escaped = (text: string) => text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');

const optionTags = (html: string) => [...html.matchAll(/<div[^>]*role="button"[^>]*>/g)].map((match) => match[0]);

describe('SidebarSideSectionView', () => {
  test('a left or right choice, left first, with the stored side chosen', () => {
    const html = view({ status: 'ready', sidebarSide: 'left', canChange: true, saving: false });
    expect(html).toContain(escaped(mittrT('mittr.sidebarSide.title')));
    expect(html).toContain('role="radiogroup"');
    expect(html.indexOf('>Left<')).toBeLessThan(html.indexOf('>Right<'));
    const tags = optionTags(html);
    expect(tags.length).toBe(2);
    expect(tags[0]).toContain('aria-pressed="true"');
    expect(tags[1]).toContain('aria-pressed="false"');
    expect(optionTags(view({ status: 'ready', sidebarSide: 'right', canChange: true, saving: false }))[1]).toContain('aria-pressed="true"');
  });

  test('while saving, or away from this Mac, the choice cannot be pressed', () => {
    for (const html of [
      view({ status: 'ready', sidebarSide: 'left', canChange: true, saving: true }),
      view({ status: 'ready', sidebarSide: 'left', canChange: false, saving: false }),
    ]) {
      for (const tag of optionTags(html)) expect(tag).toContain('aria-disabled="true"');
    }
    expect(view({ status: 'ready', sidebarSide: 'left', canChange: false, saving: false })).toContain(escaped(mittrT('mittr.sidebarSide.changeOnThisMac')));
  });

  test('loading shows nothing and a failed load shows why with a retry', () => {
    expect(view({ status: 'loading' })).toBe('');
    const html = view({ status: 'error', error: 'Could not read the sidebar setting' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Could not read the sidebar setting');
    expect(html).toContain(escaped(mittrT('mittr.sidebarSide.retry')));
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '../../../ui/src/lib/i18n';
import { DEFAULT_LOCALE } from '../../../ui/src/lib/i18n/runtime';
import { useI18nStore } from '../../../ui/src/lib/i18n/store';
import { mittrT } from '../strings/mittrT';
import type { MyWorkState } from './myWorkController';
import { MyWorkDialogView, type MyWorkDialogViewProps } from './MyWorkDialog';
import { stateRankColor, type WorkItem } from './workItems';
import { createWorkPrefs } from './workPrefs';

const item = (id: string, overrides: Partial<WorkItem> = {}): WorkItem => ({
  id,
  title: id,
  project: 'P',
  phase: null,
  state: 'In Progress',
  priority: null,
  due: null,
  estimate: null,
  url: `https://example.test/${id}`,
  updatedAt: '2026-10-20T00:00:00Z',
  source: 'plane',
  ...overrides,
});

const JIRA = item('j-1', {
  title: 'Fix login',
  source: 'jira',
  key: 'MRKB-2122',
  priority: 'High',
  due: '2026-10-30',
  url: 'https://x.atlassian.net/browse/MRKB-2122',
});

const ready = (items: WorkItem[]): MyWorkState => ({ status: 'ready', items });

const noop = () => {};

const escaped = (text: string) => text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');

const view = (props: Partial<MyWorkDialogViewProps> = {}) => renderToStaticMarkup(
  <I18nProvider>
    <MyWorkDialogView
      state={ready([JIRA])}
      filter="all"
      prefs={createWorkPrefs(null)}
      query=""
      onQuery={noop}
      onFilter={noop}
      onRefresh={noop}
      onOpenUrl={noop}
      projects={[]}
      {...props}
    />
  </I18nProvider>,
);

const chips = (html: string) => [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([\s\S]*?)<\/button>/g)]
  .map((match) => ({ pressed: match[1] === 'true', tag: match[0] }));

const waitForLocale = async (locale: string) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = useI18nStore.getState();
    if (state.locale === locale && state.loadingLocale === null) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`the UI never settled on ${locale}`);
};

afterEach(() => {
  useI18nStore.getState().setLocale(DEFAULT_LOCALE);
});

describe('My work panel', () => {
  test('rows show the key, title and state', () => {
    const html = view();
    expect(html).toContain('MRKB-2122');
    expect(html).toContain('Fix login');
    expect(html).toContain('In Progress');
    expect(html).toContain(stateRankColor(0));
    expect(html).toContain(escaped(mittrT('mittr.work.row.priority', { priority: 'High' })));
    expect(html).toContain(escaped(mittrT('mittr.work.row.due', { due: '2026-10-30' })));
    expect(html).toContain('href="https://x.atlassian.net/browse/MRKB-2122"');
  });

  test('two Plane workspaces show two chips named after them', () => {
    const html = view({ state: ready([JIRA, item('p-1', { workspace: 'alpha' }), item('p-2', { workspace: 'beta' })]) });
    for (const workspace of ['alpha', 'beta']) {
      expect(html).toContain(`aria-label="${escaped(mittrT('mittr.work.source.planeWorkspace', { workspace }))} 1"`);
    }
    expect(chips(html)).toHaveLength(4);
  });

  test('a single Plane workspace shows one Plane chip that counts its items', () => {
    const html = view({ state: ready([item('p-1', { workspace: 'alpha' }), item('p-2', { workspace: 'alpha' })]) });
    expect(chips(html)).toHaveLength(2);
    expect(html).toContain(`aria-label="${mittrT('mittr.work.source.plane')} 2"`);
    expect(html).not.toContain(escaped(mittrT('mittr.work.source.planeWorkspace', { workspace: 'alpha' })));
  });

  test('the saved filter presses its chip, and a stale one falls back to All', () => {
    const items = [JIRA, item('p-1')];
    const pressed = (filter: string) => chips(view({ state: ready(items), filter })).map((chip) => chip.pressed);
    expect(pressed('jira')).toEqual([false, true, false]);
    expect(pressed('plane:gone')).toEqual([true, false, false]);
    const scoped = view({ state: ready(items), filter: 'jira' });
    expect(scoped).toContain('Fix login');
    expect(scoped).not.toContain('href="https://example.test/p-1"');
  });

  test('the title filter narrows the rows and the counts', () => {
    const html = view({ state: ready([JIRA, item('p-1', { title: 'Plan sprint' })]), query: 'login' });
    expect(html).not.toContain('Plan sprint');
    expect(html).toContain(`aria-label="${mittrT('mittr.work.source.plane')} 0"`);
    expect(view({ state: ready([JIRA]), query: 'nothing' })).toContain(escaped(mittrT('mittr.work.filter.empty', { query: 'nothing' })));
  });

  test('the not-connected state shows its text and no list', () => {
    const html = view({ state: { status: 'not-connected', items: [] } });
    expect(html).toContain(mittrT('mittr.work.notConnected'));
    expect(html).not.toContain('<a ');
  });

  test('an error shows its text as an alert and no list', () => {
    const html = view({ state: { status: 'error', items: [], error: 'Mittr platform is unavailable' } });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Mittr platform is unavailable');
    expect(html).toContain('--status-error');
    expect(html).not.toContain('<a ');
  });

  test('loading shows its text and keeps Refresh disabled', () => {
    const html = view({ state: { status: 'loading', items: [] } });
    expect(html).toContain(mittrT('mittr.work.loading'));
    expect(/<button[^>]*disabled=""[^>]*>[\s\S]*?Refresh<\/button>/.test(html)).toBe(true);
  });

  test('no work shows the empty text', () => {
    expect(view({ state: ready([]) })).toContain(mittrT('mittr.work.empty'));
  });

  test('Go work is shown only when it can start work', () => {
    expect(view()).not.toContain(mittrT('mittr.work.actions.goWork'));
    expect(view({ onGoWork: noop })).toContain(mittrT('mittr.work.actions.goWork'));
  });

  test('Mittr strings are English in Japanese', async () => {
    useI18nStore.getState().setLocale('ja');
    await waitForLocale('ja');
    const html = view({ state: { status: 'not-connected', items: [] } });
    expect(html).toContain('The Mittr platform is not connected yet.');
    expect(html).toContain('>Refresh</button>');
    expect(html).toContain('placeholder="Filter by title..."');
  });
});

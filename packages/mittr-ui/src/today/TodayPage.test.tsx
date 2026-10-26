import { afterAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from '../../../ui/node_modules/happy-dom';

import type { TodayRow } from './todayData';
import type { TodayViewProps } from './TodayPage';

const browser = new Window({ url: 'http://localhost/' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  Node: browser.Node,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  Event: browser.Event,
  MouseEvent: browser.MouseEvent,
  localStorage: browser.localStorage,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  matchMedia: browser.matchMedia.bind(browser),
  fetch: () => new Promise<Response>(() => {}),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

afterAll(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('../../../ui/src/lib/i18n');
const { TodayPage, TodayView } = await import('./TodayPage');
const { registerTodaySection, setTodayAlerts } = await import('./todaySections');

const opened: string[] = [];
const row = (id: string, kind: TodayRow['kind'], title: string, detail = ''): TodayRow => ({ id, kind, title, detail, open: () => { opened.push(id); } });

const base: TodayViewProps = {
  now: new Date(2026, 9, 22, 9, 30).getTime(),
  waitingRows: [],
  runningRows: [],
  alertRows: [],
  work: { status: 'ready', items: [] },
  workItems: [],
  onConnectWork: () => { opened.push('connect'); },
  onMoreWork: () => { opened.push('more'); },
  widgets: null,
  launcher: null,
};

const markup = (props: Partial<TodayViewProps> = {}) => renderToStaticMarkup(<TodayView {...base} {...props} />);

describe('the Today page', () => {
  test('the date is large and the greeting counts what is waiting', () => {
    const html = markup({ waitingRows: [row('a', 'approval', 'Room A'), row('b', 'review', 'Room B')] });
    expect(html).toContain('>Thu, Oct 22</h1>');
    expect(html).toContain('Good morning. 2 things are waiting for you.');
    expect(markup()).toContain('Good morning. Nothing is waiting for you.');
    expect(markup({ waitingRows: [row('a', 'approval', 'Room A')] })).toContain('1 thing is waiting for you.');
  });

  test('the alert strip shows only when there is an alert', () => {
    expect(markup()).not.toContain('mittr-today-alerts');
    expect(markup({ alertRows: [row('q', 'quota', "mittr-fast: 15% of this week's quota left")] })).toContain('mittr-today-alerts');
  });

  test('empty panels say so instead of showing made-up rows', () => {
    const html = markup();
    expect(html).toContain('Nothing needs you right now.');
    expect(html).toContain('Nothing is running.');
    expect(html).toContain('Nothing is assigned to you.');
  });

  test('the work panel shows a connect link when work tracking is not connected', async () => {
    opened.length = 0;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<TodayView {...base} work={{ status: 'not-connected', items: [] }} />));
    expect(container.textContent).toContain('Connect Jira or Plane to see your work here.');
    const link = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Connect work tracking');
    await act(async () => { link?.click(); });
    expect(opened).toEqual(['connect']);
    await act(async () => root.unmount());
    container.remove();
  });

  test('every row opens its own thing', async () => {
    opened.length = 0;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(
      <TodayView
        {...base}
        waitingRows={[row('w1', 'approval', 'Room A', 'bash')]}
        runningRows={[row('r1', 'running', 'Room B', 'Working')]}
        alertRows={[row('al1', 'error', 'Room C', 'Ended with an error')]}
        workItems={[row('k1', 'work', 'Card 1')]}
      />,
    ));
    const buttons = [...container.querySelectorAll('button')];
    for (const text of ['Room A', 'Room B', 'Room C', 'Card 1']) {
      const button = buttons.find((candidate) => candidate.textContent?.includes(text));
      await act(async () => { button?.click(); });
    }
    expect(opened).toEqual(['w1', 'r1', 'al1', 'k1']);
    await act(async () => root.unmount());
    container.remove();
  });

  test('more than five work items leave a way to the rest in My work', () => {
    const items = Array.from({ length: 7 }, (_, index) => row(`k${index}`, 'work', `Card ${index}`));
    const html = markup({ workItems: items });
    expect(html).toContain('Card 4');
    expect(html).not.toContain('Card 5');
    expect(html).toContain('2 more in My work');
  });

  test('there is no widgets panel until one is registered', () => {
    const page = () => renderToStaticMarkup(<I18nProvider><TodayPage /></I18nProvider>);
    const before = page();
    expect(before).toContain('mittr-today');
    expect(before).not.toContain('data-today-section="widgets"');
    expect(before).toContain('data-columns="2"');
    const stop = registerTodaySection('widgets', () => <p>probe widgets</p>);
    const after = page();
    expect(after).toContain('data-today-section="widgets"');
    expect(after).toContain('probe widgets');
    stop();
    expect(page()).not.toContain('data-today-section="widgets"');
  });

  test('alerts a section adds reach the strip', () => {
    setTodayAlerts('probe', [row('x', 'quota', 'Probe alert')]);
    const html = renderToStaticMarkup(<I18nProvider><TodayPage /></I18nProvider>);
    expect(html).toContain('Probe alert');
    setTodayAlerts('probe', []);
    expect(renderToStaticMarkup(<I18nProvider><TodayPage /></I18nProvider>)).not.toContain('Probe alert');
  });
});

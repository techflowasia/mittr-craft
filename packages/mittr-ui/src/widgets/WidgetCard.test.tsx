import { afterAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from '../../../ui/node_modules/happy-dom';

import type { Widget } from './widgetsApi';

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
  getComputedStyle: browser.getComputedStyle.bind(browser),
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
const { WidgetCard } = await import('./WidgetCard');

const COMMAND = 'curl -s https://ci.example.test/job/dev/lastBuild/api/json | jq -r .result';
const AT = new Date(2026, 9, 22, 12, 41).getTime();

const commandWidget: Widget = {
  id: 'wid_0123456789abcdef',
  title: 'Jenkins dev build',
  display: 'status',
  source: { type: 'command', command: COMMAND, cwd: '/work/app' },
  refreshMinutes: 15,
  enabled: false,
  alerting: false,
};

const urlWidget: Widget = {
  id: 'wid_fedcba9876543210',
  title: 'Headphone price',
  display: 'number',
  source: { type: 'url', url: 'https://shop.example.test/item/42?ref=a&b=1' },
  refreshMinutes: 60,
  alert: { op: 'below', value: 11500 },
  enabled: true,
  last: { at: AT, value: { kind: 'number', value: 12990 } },
  alerting: false,
};

const calls: string[] = [];
const handlers = {
  onEnable: (id: string) => { calls.push(`enable:${id}`); },
  onDisable: (id: string) => { calls.push(`disable:${id}`); },
  onRefresh: (id: string) => { calls.push(`refresh:${id}`); },
  onRemove: (id: string) => { calls.push(`remove:${id}`); },
};

const markup = (widget: Widget) => renderToStaticMarkup(<WidgetCard widget={widget} busy={false} {...handlers} />);

const mount = async (widget: Widget) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<WidgetCard widget={widget} busy={false} {...handlers} />));
  const click = async (label: string) => {
    const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
    if (!button) throw new Error(`no ${label} button`);
    await act(async () => { button.click(); });
  };
  const close = async () => { await act(async () => root.unmount()); container.remove(); };
  return { container, click, close };
};

const timeOf = (at: number) => new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit' }).format(at);

describe('a widget card', () => {
  test('a card that is off shows the exact command, where it runs and how often, and a Turn on button', () => {
    const html = renderToStaticMarkup(<WidgetCard widget={commandWidget} busy={false} {...handlers} />);
    expect(html).toContain('Jenkins dev build');
    expect(html).toContain(`<code class="mittr-widget-source">${COMMAND.replace(/&/g, '&amp;').replace(/>/g, '&gt;')}</code>`);
    expect(html).toContain('in /work/app');
    expect(html).toContain('every 15 min');
    expect(html).toContain('>Turn on</button>');
    expect(html).toContain('data-enabled="false"');
  });

  test('a URL card that is off shows the exact URL', () => {
    const html = markup({ ...urlWidget, enabled: false, last: undefined });
    expect(html).toContain('Reads');
    expect(html).toContain('https://shop.example.test/item/42?ref=a&amp;b=1');
    expect(html).toContain('>Turn on</button>');
  });

  test('Turn on calls the enable route for that widget', async () => {
    calls.length = 0;
    const view = await mount(commandWidget);
    await view.click('Turn on');
    expect(calls).toEqual(['enable:wid_0123456789abcdef']);
    await view.close();
  });

  test('a card that is on shows its value and when it last updated', () => {
    const html = markup(urlWidget);
    expect(html).toContain('12,990');
    expect(html).toContain(`Updated ${timeOf(AT)}`);
    expect(html).not.toContain('>Turn on</button>');
    expect(html).toContain('>Turn off</button>');
  });

  test('a status card names its state in words, and a list shows its lines', () => {
    expect(markup({ ...commandWidget, enabled: true, last: { at: AT, value: { kind: 'text', value: 'fail' } } })).toContain('Failing');
    const list = markup({ ...commandWidget, display: 'list', enabled: true, last: { at: AT, value: { kind: 'lines', value: ['one', 'two'] } } });
    expect(list).toContain('<li>one</li><li>two</li>');
  });

  test('a card shows its last error', () => {
    const html = markup({ ...urlWidget, last: { at: AT, error: 'Timed out after 20 s' } });
    expect(html).toContain('Timed out after 20 s');
    expect(html).toContain('role="alert"');
  });

  test('a card that has not run yet says so', () => {
    expect(markup({ ...urlWidget, last: undefined })).toContain('Not updated yet');
  });

  test('an alerting card is marked in words, not by colour alone', () => {
    const html = markup({ ...urlWidget, alerting: true });
    expect(html).toContain('data-alerting="true"');
    expect(html).toContain('Past its alert line');
    expect(markup(urlWidget)).not.toContain('Past its alert line');
  });

  test('Remove asks first, and only the confirmation calls DELETE', async () => {
    calls.length = 0;
    const view = await mount(urlWidget);
    await view.click('Remove');
    expect(calls).toEqual([]);
    expect(view.container.textContent).toContain('Remove this widget?');
    await view.click('Keep');
    expect(view.container.textContent).not.toContain('Remove this widget?');
    await view.click('Remove');
    const confirm = [...view.container.querySelectorAll<HTMLButtonElement>('[data-confirm] button')].find((button) => button.textContent === 'Remove');
    await act(async () => { confirm?.click(); });
    expect(calls).toEqual(['remove:wid_fedcba9876543210']);
    await view.close();
  });

  test('Refresh now asks for a run', async () => {
    calls.length = 0;
    const view = await mount(urlWidget);
    await view.click('Refresh now');
    expect(calls).toEqual(['refresh:wid_fedcba9876543210']);
    await view.close();
  });
});

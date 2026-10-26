import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { Window } from '../../../ui/node_modules/happy-dom';

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
  FocusEvent: browser.FocusEvent,
  KeyboardEvent: browser.KeyboardEvent,
  MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver,
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
const { createPortal } = await import('react-dom');
const { TodayView } = await import('./TodayPage');
const { TodayLauncherView } = await import('./TodayLauncher');

const noop = () => {};

const props: TodayViewProps = {
  now: new Date(2026, 9, 22, 9, 30).getTime(),
  waitingRows: [],
  runningRows: [],
  alertRows: [],
  work: { status: 'ready', items: [] },
  workItems: [],
  onConnectWork: noop,
  onMoreWork: noop,
  widgets: null,
  launcher: <TodayLauncherView projects={[]} project={null} onProject={noop} onLaunch={noop} />,
};

const mountMain = async () => {
  const main = document.createElement('main');
  main.setAttribute('data-product-region', 'main');
  const chat = document.createElement('div');
  const composer = document.createElement('textarea');
  composer.className = 'composer';
  chat.append(composer);
  const typed: string[] = [];
  composer.addEventListener('keydown', (event) => { typed.push(event.key); });
  main.append(chat);
  const host = document.createElement('div');
  document.body.append(main, host);
  composer.focus();
  const root = createRoot(host);
  const show = async () => act(async () => root.render(createPortal(<TodayView {...props} />, main)));
  const hide = async () => act(async () => root.render(null));
  const launcher = () => main.querySelector<HTMLTextAreaElement>('.mittr-today-input');
  const close = async () => {
    await act(async () => root.unmount());
    main.remove();
    host.remove();
  };
  return { main, chat, composer, typed, show, hide, launcher, close };
};

describe('C2: Today covers the chat beneath it', () => {
  test('when Today opens, the hidden chat is inert and the launcher has the focus', async () => {
    const view = await mountMain();
    expect(document.activeElement).toBe(view.composer);
    await view.show();
    expect(view.chat.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(view.launcher());
    await view.hide();
    expect(view.chat.hasAttribute('inert')).toBe(false);
    await view.close();
  });

  test('the hidden composer cannot take the focus back, so keys typed on Today never reach it', async () => {
    const view = await mountMain();
    await view.show();
    view.composer.focus();
    expect(document.activeElement).toBe(view.launcher());
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(view.typed).toEqual([]);
    await view.close();
  });

  test('a chat part that mounts while Today is open is covered too, and one already inert is left as it was', async () => {
    const view = await mountMain();
    const already = document.createElement('div');
    already.setAttribute('inert', '');
    view.main.prepend(already);
    await view.show();
    const later = document.createElement('div');
    view.main.prepend(later);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(later.hasAttribute('inert')).toBe(true);
    await view.hide();
    expect(later.hasAttribute('inert')).toBe(false);
    expect(already.hasAttribute('inert')).toBe(true);
    await view.close();
  });

  test('the chat under Today is hidden on every theme, with nothing in it able to show itself again', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, 'today.css'), 'utf8');
    const rule = /([^{}]+)\{\s*visibility:\s*hidden !important;\s*\}/.exec(css);
    expect(rule).not.toBeNull();
    const selectors = (rule?.[1] ?? '').split(',').map((selector) => selector.trim());
    expect(selectors).toEqual([
      '[data-product-region="main"]:has(> .mittr-today) > :not(.mittr-today)',
      '[data-product-region="main"]:has(> .mittr-today) > :not(.mittr-today) *',
    ]);
    expect(css).not.toContain('html.mittr-glass');
  });
});

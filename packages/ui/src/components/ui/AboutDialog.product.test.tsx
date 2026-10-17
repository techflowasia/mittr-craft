import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  Event: browser.Event, MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent,
  KeyboardEvent: browser.KeyboardEvent, FocusEvent: browser.FocusEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  fetch: () => new Promise<Response>(() => {}),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { registerProductUiPlugin, resetProductUiPluginsForTests } = await import('@/lib/product-plugins');
const { AboutDialog } = await import('./AboutDialog');

const renderOpenDialog = async (): Promise<string> => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<I18nProvider><AboutDialog open onOpenChange={() => {}} /></I18nProvider>);
    });
    return document.body.innerHTML;
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
};

afterEach(() => {
  resetProductUiPluginsForTests();
});

afterAll(async () => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  await browser.happyDOM.close();
});

describe('AboutDialog product slot', () => {
  test('AboutDialog renders the product slot', async () => {
    registerProductUiPlugin({
      id: 'about-probe',
      slots: { 'about-dialog': () => <span data-probe="about">Product about item</span> },
    });
    const html = await renderOpenDialog();
    expect(html).toContain('Product about item');
    expect(html.indexOf('data-probe="about"')).toBeGreaterThan(html.indexOf('<h2'));
  });

  test('with no plugin the slot renders nothing', async () => {
    const html = await renderOpenDialog();
    expect(html).toContain('<h2');
    expect(html).not.toContain('data-probe');
  });
});

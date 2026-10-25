import { afterAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  Event: browser.Event, MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  matchMedia: browser.matchMedia.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useUIStore } = await import('@/stores/useUIStore');
const { Sidebar } = await import('./Sidebar');

afterAll(async () => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  await browser.happyDOM.close();
});

const pointer = (type: string, clientX: number) => new PointerEvent(type, { bubbles: true, pointerId: 1, clientX });

const dragBy = async (side: 'left' | 'right' | undefined, dx: number): Promise<{ width: number; html: string }> => {
  useUIStore.setState({ sidebarWidth: 280 });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <Sidebar isOpen isMobile={false} side={side}>
            <div />
          </Sidebar>
        </I18nProvider>,
      );
    });
    const html = container.innerHTML;
    const handle = container.querySelector('[role="separator"]');
    if (!handle) throw new Error('no resize handle');
    await act(async () => { handle.dispatchEvent(pointer('pointerdown', 500)); });
    await act(async () => { handle.dispatchEvent(pointer('pointermove', 500 + dx)); });
    await act(async () => { handle.dispatchEvent(pointer('pointerup', 500 + dx)); });
    return { width: useUIStore.getState().sidebarWidth, html };
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
};

describe('Sidebar side', () => {
  test('on the left edge the handle is on its right and dragging right widens it', async () => {
    const { width, html } = await dragBy(undefined, 60);
    expect(width).toBe(340);
    expect(html).toContain('border-r');
    expect(html).toContain('class="absolute right-0 top-0 ');
  });

  test('on the right edge the handle is on its left and dragging left widens it', async () => {
    const { width, html } = await dragBy('right', -60);
    expect(width).toBe(340);
    expect(html).toContain('border-l');
    expect(html).not.toContain('border-r');
    expect(html).toContain('class="absolute left-0 top-0 ');
  });

  test('on the right edge dragging right narrows it', async () => {
    expect((await dragBy('right', 10)).width).toBe(270);
  });
});

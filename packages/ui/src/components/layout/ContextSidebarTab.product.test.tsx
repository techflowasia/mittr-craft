import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';

import type { ProductSlotProps } from '@/lib/product-plugins';

plugin({
  name: 'context-panel-vite-imports',
  setup(build) {
    build.onLoad({ filter: /\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

const browser = new Window({ url: 'http://localhost/' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, NodeList: browser.NodeList, Element: browser.Element, HTMLElement: browser.HTMLElement,
  SVGElement: browser.SVGElement, Event: browser.Event, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  matchMedia: browser.matchMedia.bind(browser),
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
const { SyncProvider } = await import('@/sync/sync-context');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { registerProductUiPlugin, resetProductUiPluginsForTests } = await import('@/lib/product-plugins');
const { ContextPanelContent } = await import('./ContextSidebarTab');

const sdk = OpenCode.make({ baseUrl: 'http://api.example.test', fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }) });

const panel = async (): Promise<string> => {
  useSessionUIStore.setState({ currentSessionId: 'ses_acme', currentSessionDirectory: '/acme' });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <SyncProvider sdk={sdk} directory="/acme">
          <I18nProvider>
            <ContextPanelContent />
          </I18nProvider>
        </SyncProvider>,
      );
    });
    return container.innerHTML;
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
};

afterEach(() => {
  resetProductUiPluginsForTests();
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
});

afterAll(async () => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  await browser.happyDOM.close();
});

describe('ContextPanelContent product slot', () => {
  test('with no plugin the raw messages section renders', async () => {
    const html = await panel();
    expect(html).toContain('Raw Messages');
    expect(html).not.toContain('data-probe');
  });

  test('a plugin that fills the slot takes the place of the raw messages section', async () => {
    const seen: ProductSlotProps['context-raw-messages'][] = [];
    registerProductUiPlugin({
      id: 'acme',
      slots: {
        'context-raw-messages': (props) => {
          seen.push(props);
          return <div data-probe="acme-activity">Acme activity</div>;
        },
      },
    });
    const html = await panel();
    expect(html).toContain('data-probe="acme-activity"');
    expect(html).not.toContain('Raw Messages');
    expect(html.indexOf('data-probe="acme-activity"')).toBeGreaterThan(html.lastIndexOf('rounded-full'));
    expect(seen.at(-1)?.sessionId).toBe('ses_acme');
    expect(seen.at(-1)?.directory).toBe('/acme');
    expect(seen.at(-1)?.messages).toEqual([]);
  });

  test('a plugin that throws leaves the rest of the panel in place', async () => {
    registerProductUiPlugin({
      id: 'acme',
      slots: {
        'context-raw-messages': () => {
          throw new Error('acme failed');
        },
      },
    });
    const original = console.error;
    console.error = () => {};
    try {
      const html = await panel();
      expect(html).toContain('rounded-full');
      expect(html).not.toContain('Raw Messages');
    } finally {
      console.error = original;
    }
  });
});

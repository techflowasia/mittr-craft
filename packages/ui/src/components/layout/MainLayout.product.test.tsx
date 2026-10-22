import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';

import type { RuntimeAPIs } from '@/lib/api/types';

plugin({
  name: 'main-layout-vite-imports',
  setup(build) {
    build.onLoad({ filter: /\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
    build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
      const folder = resolve(dirname(path), '../assets/provider-logos');
      const logos = Object.fromEntries(readdirSync(folder).filter((name) => name.endsWith('.svg'))
        .map((name) => [`../assets/provider-logos/${name}`, pathToFileURL(resolve(folder, name)).href]));
      const contents = readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`);
      return { contents, loader: 'ts' };
    });
  },
});

const browser = new Window({ url: 'http://localhost/' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, NodeList: browser.NodeList, Element: browser.Element, HTMLElement: browser.HTMLElement,
  SVGElement: browser.SVGElement, HTMLAnchorElement: browser.HTMLAnchorElement,
  Event: browser.Event, MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent,
  KeyboardEvent: browser.KeyboardEvent, FocusEvent: browser.FocusEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  IntersectionObserver: browser.IntersectionObserver, customElements: browser.customElements,
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
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { SyncProvider } = await import('@/sync/sync-context');
const { registerProductUiPlugin, resetProductUiPluginsForTests } = await import('@/lib/product-plugins');
const { MainLayout } = await import('./MainLayout');

const pending = (): Promise<never> => new Promise<never>(() => {});
const inert = <T extends object>(): T => new Proxy<T>(Object.create(null), { get: () => pending });
const runtimeApis: RuntimeAPIs = {
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  terminal: inert(),
  git: inert(),
  sourceControl: inert(),
  files: inert(),
  settings: inert(),
  permissions: inert(),
  notifications: inert(),
};
const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }) });

const layout = async (): Promise<string> => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <RuntimeAPIContext.Provider value={runtimeApis}>
          <SyncProvider sdk={sdk} directory="/project">
            <I18nProvider>
              <ThemeSystemProvider>
                <MainLayout />
              </ThemeSystemProvider>
            </I18nProvider>
          </SyncProvider>
        </RuntimeAPIContext.Provider>,
      );
    });
    return container.innerHTML;
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
};

const between = (html: string, open: string, close: string): string => {
  const start = html.indexOf(open);
  const end = html.indexOf(close, start);
  return start >= 0 && end > start ? html.slice(start, end) : '';
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

describe('MainLayout product surface', () => {
  test('the main-surface slot renders inside the main element', async () => {
    registerProductUiPlugin({
      id: 'surface-probe',
      slots: { 'main-surface': () => <div data-testid="surface-probe" /> },
    });
    const html = await layout();
    expect(between(html, '<main', '</main>')).toContain('data-testid="surface-probe"');
  });

  test('the layout names its regions', async () => {
    const html = await layout();
    expect(html).toContain('data-product-region="shell"');
    expect(html).toContain('data-product-region="column"');
    expect(html).toMatch(/<main[^>]*data-product-region="main"/);
  });

  test('with no plugin the slot renders nothing', async () => {
    expect(await layout()).not.toContain('surface-probe');
  });
});

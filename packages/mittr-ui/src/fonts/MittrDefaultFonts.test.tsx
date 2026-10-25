import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from '../../../ui/node_modules/happy-dom';

const browser = new Window({ url: 'http://localhost/' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  matchMedia: browser.matchMedia.bind(browser),
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
const { useUIStore } = await import('../../../ui/src/stores/useUIStore');
const { createFontChoices } = await import('./defaultFonts');
const { MittrDefaultFonts } = await import('./MittrDefaultFonts');

const classes = (): string[] => [...document.documentElement.classList].filter((name) => name.startsWith('mittr-plex-')).sort();

test('Plex is on for the defaults, a person\'s pick replaces it, and leaving with the app takes the classes away', async () => {
  useUIStore.setState({ uiFont: 'system', monoFont: 'system-mono' });
  const root = createRoot(document.createElement('div'));
  await act(async () => {
    root.render(<MittrDefaultFonts createChoices={() => createFontChoices(null)} />);
  });
  expect(classes()).toEqual(['mittr-plex-mono', 'mittr-plex-sans']);

  await act(async () => useUIStore.setState({ uiFont: 'inter' }));
  expect(classes()).toEqual(['mittr-plex-mono']);

  await act(async () => useUIStore.setState({ uiFont: 'system' }));
  expect(classes()).toEqual(['mittr-plex-mono']);

  await act(async () => useUIStore.setState({ monoFont: 'fira-code' }));
  expect(classes()).toEqual([]);

  await act(async () => root.unmount());
  expect(classes()).toEqual([]);
});

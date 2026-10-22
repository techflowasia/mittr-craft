import { afterAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from '../../../ui/node_modules/happy-dom';

import type { ThemeContextValue } from '../../../ui/src/contexts/theme-system-context';
import type { Theme } from '../../../ui/src/types/theme';
import type { MittrSurface } from '../mittrSurface';

const browser = new Window({ url: 'http://localhost/' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
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
const { ThemeSystemContext } = await import('../../../ui/src/contexts/theme-system-context');
const { getThemeById } = await import('../../../ui/src/lib/theme/themes');
const { MittrSurfaceContext } = await import('../mittrSurface');
const { useGlassTheme } = await import('./useGlassTheme');
const { GlassSky } = await import('./GlassSky');

const themeOf = (id: string): Theme => {
  const theme = getThemeById(id);
  if (!theme) throw new Error(`no theme ${id}`);
  return theme;
};

const noop = (): void => {};
const contextFor = (theme: Theme): ThemeContextValue => ({
  currentTheme: theme,
  availableThemes: [theme],
  customThemeIds: [],
  setTheme: noop,
  customThemesLoading: false,
  reloadCustomThemes: async () => {},
  importTheme: async () => theme,
  deleteImportedTheme: async () => {},
  isSystemPreference: false,
  setSystemPreference: noop,
  themeMode: theme.metadata.variant === 'dark' ? 'dark' : 'light',
  setThemeMode: noop,
  lightThemeId: theme.metadata.id,
  darkThemeId: theme.metadata.id,
  setLightThemePreference: noop,
  setDarkThemePreference: noop,
});

const seen: boolean[] = [];
function Probe(): null {
  seen.push(useGlassTheme());
  return null;
}

const mount = () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (themeId: string, surface: MittrSurface = 'main') => act(async () => {
    root.render(
      <ThemeSystemContext.Provider value={contextFor(themeOf(themeId))}>
        <MittrSurfaceContext.Provider value={surface}>
          <Probe />
          <GlassSky />
        </MittrSurfaceContext.Provider>
      </ThemeSystemContext.Provider>,
    );
  });
  return { container, render, unmount: () => act(async () => root.unmount()) };
};

const classes = (): string[] => [...document.documentElement.classList].filter((name) => name.startsWith('mittr-glass')).sort();

describe('the glass theme switch', () => {
  test('the default light theme sets mittr-glass, and the sky is drawn', async () => {
    const view = mount();
    await view.render('openchamber-light');
    expect(classes()).toEqual(['mittr-glass']);
    expect(seen.at(-1)).toBe(true);
    expect(view.container.innerHTML).toContain('class="mittr-glass-sky"');
    await view.unmount();
  });

  test('the default dark theme also sets mittr-glass-dark', async () => {
    const view = mount();
    await view.render('openchamber-dark');
    expect(classes()).toEqual(['mittr-glass', 'mittr-glass-dark']);
    await view.unmount();
  });

  test('another theme sets no class and draws no sky, and switching back restores both', async () => {
    const view = mount();
    await view.render('openchamber-light');
    await view.render('flexoki-light');
    expect(classes()).toEqual([]);
    expect(seen.at(-1)).toBe(false);
    expect(view.container.innerHTML).not.toContain('mittr-glass-sky');
    await view.render('openchamber-dark');
    expect(classes()).toEqual(['mittr-glass', 'mittr-glass-dark']);
    expect(view.container.innerHTML).toContain('mittr-glass-sky');
    await view.unmount();
  });

  test('the mini-chat window is marked too', async () => {
    const view = mount();
    await view.render('openchamber-light', 'mini-chat');
    expect(classes()).toEqual(['mittr-glass', 'mittr-glass-mini']);
    await view.unmount();
  });

  test('unmounting removes every class it set', async () => {
    const view = mount();
    await view.render('openchamber-dark', 'mini-chat');
    await view.unmount();
    expect(classes()).toEqual([]);
  });

  test('a first start that follows the system turns to the light sky once, and a later choice stays', async () => {
    localStorage.removeItem('mittr.glass.lightDefault');
    const modes: string[] = [];
    const container = document.createElement('div');
    const root = createRoot(container);
    const renderWith = (themeMode: 'system' | 'dark') => act(async () => {
      root.render(
        <ThemeSystemContext.Provider value={{ ...contextFor(themeOf('openchamber-dark')), themeMode, setThemeMode: (mode) => { modes.push(mode); } }}>
          <Probe />
        </ThemeSystemContext.Provider>,
      );
    });
    await renderWith('system');
    expect(modes).toEqual(['light']);
    await renderWith('dark');
    await renderWith('system');
    expect(modes).toEqual(['light']);
    await act(async () => root.unmount());
  });

  test('without a theme context there is no glass', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<Probe />));
    expect(seen.at(-1)).toBe(false);
    expect(classes()).toEqual([]);
    await act(async () => root.unmount());
  });
});

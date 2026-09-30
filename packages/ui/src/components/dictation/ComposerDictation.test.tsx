import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

const stored: Record<string, string> = { sttProvider: 'mittr' };
const globals = globalThis as unknown as { window?: unknown; localStorage?: unknown; navigator: { mediaDevices?: unknown } };
globals.window = {
  AudioContext: class {},
  addEventListener: () => {},
  removeEventListener: () => {},
  location: { search: '', hash: '', pathname: '/', href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', host: 'localhost', hostname: 'localhost' },
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  navigator: globalThis.navigator,
};
globals.localStorage = {
  getItem: (key: string) => stored[key] ?? null,
  setItem: (key: string, value: string) => {
    stored[key] = value;
  },
  removeItem: (key: string) => {
    delete stored[key];
  },
};
Object.defineProperty(globals.navigator, 'mediaDevices', { value: { getUserMedia: async () => ({}) }, configurable: true });

let blockedUntil: string | null = null;
const realStore = await import('@/lib/mittr-quota/speech-quota-store');
mock.module('@/lib/mittr-quota/speech-quota-store', () => ({
  ...realStore,
  useSpeechQuotaBlock: () => blockedUntil,
}));

const { ThemeSystemContext } = await import('@/contexts/theme-system-context');
const { I18nProvider } = await import('@/lib/i18n');
const { ComposerDictation } = await import('./ComposerDictation');

const render = () =>
  renderToStaticMarkup(
    <I18nProvider>
      <ThemeSystemContext.Provider value={{ currentTheme: { colors: {} } } as unknown as React.ContextType<typeof ThemeSystemContext>}>
        <ComposerDictation
          isMobile={false}
          footerIconButtonClass=""
          footerPaddingClass=""
          iconSizeClass=""
          sendIconSizeClass=""
          onInsert={() => {}}
          onInsertAndSend={() => {}}
        />
      </ThemeSystemContext.Provider>
    </I18nProvider>,
  );

describe('ComposerDictation mic with Mittr dictation', () => {
  test('is available while voice input has quota', () => {
    blockedUntil = null;
    const html = render();
    expect(html).toContain('aria-label="Start dictation"');
    expect(html).not.toContain('disabled=""');
  });

  test('is disabled and says until when while voice input is out of quota', () => {
    blockedUntil = '2026-10-04T17:00:00.000Z';
    const html = render();
    expect(html).toContain('disabled=""');
    expect(html).toContain('Voice input is out of quota until');
    expect(html).not.toContain('aria-label="Start dictation"');
  });
});

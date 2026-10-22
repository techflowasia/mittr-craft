import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from '../../../ui/node_modules/happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.defineProperty(browser.navigator, 'mediaDevices', {
  value: { getUserMedia: () => Promise.reject(new Error('no microphone in tests')) },
  configurable: true,
});
Object.defineProperty(browser, 'AudioContext', { value: class {}, configurable: true });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  fetch: () => new Promise<Response>(() => {}),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const { createRoot } = await import('react-dom/client');
const { useConfigStore } = await import('../../../ui/src/stores/useConfigStore');
const { MittrSurfaceContext } = await import('../mittrSurface');
const { ComposerVoiceActions } = await import('./ComposerVoiceActions');
const { speechQuotaStore } = await import('./speechQuotaStore');
const { talkStore } = await import('./talkStore');

type Surface = 'main' | 'mini-chat';

const BASE_URL = 'http://127.0.0.1:57188/mittr-speech/v1';
const READY = { listen: true, speak: true, voice: true, signedIn: true, here: true, voiceSilenceMs: 900, reason: null };

const render = async (surface: Surface | null): Promise<string> => {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(
    <MittrSurfaceContext.Provider value={surface}>
      <ComposerVoiceActions isMobile={false} footerIconButtonClass="acme-icon-button" iconSizeClass="acme-icon-size" dictationActive={false} />
    </MittrSurfaceContext.Provider>,
  ));
  const html = container.innerHTML;
  await act(async () => root.unmount());
  return html;
};

afterEach(() => {
  talkStore.reset();
  speechQuotaStore.reset();
  useConfigStore.setState({ sttProvider: 'local', sttServerUrl: 'http://localhost:8001/v1' });
});

afterAll(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('the composer voice actions', () => {
  test('Talk renders beside the microphone when voice is ready', async () => {
    talkStore.setState({ readiness: READY });
    const html = await render('main');
    expect(html).toContain('aria-label="Talk"');
    expect(html).toContain('class="acme-icon-button"');
    expect(html).toContain('acme-icon-size');
  });

  test('the mini window renders no Talk button', async () => {
    talkStore.setState({ readiness: READY });
    expect(await render('mini-chat')).toBe('');
    expect(await render(null)).toBe('');
  });

  test('nothing renders before readiness is known', async () => {
    expect(await render('main')).toBe('');
  });

  test('the microphone block reason is shown beside the microphone while voice input is used up', async () => {
    useConfigStore.setState({ sttProvider: 'openai-compatible', sttServerUrl: BASE_URL });
    speechQuotaStore.block('stt', '2099-10-26T17:00:00.000Z');
    talkStore.setState({ readiness: READY });
    const html = await render('main');
    expect(html).toContain('role="status"');
    expect(html).toContain('Voice input is out of quota until');
    expect(html).toContain('disabled=""');
  });
});

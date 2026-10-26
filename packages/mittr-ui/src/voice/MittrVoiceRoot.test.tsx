import { afterAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from '../../../ui/node_modules/happy-dom';

const browser = new Window({ url: 'http://localhost/' });
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
const { MittrErrorBoundary } = await import('../MittrErrorBoundary');
const { MittrRoot } = await import('../MittrRoot');
const { MittrSignInGate } = await import('../sign-in/MittrSignInGate');
const { MittrVoiceMount, MittrVoiceRoot } = await import('./MittrVoiceRoot');
const { createVoiceController } = await import('./voiceController');

afterAll(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const READY = { listen: true, speak: true, voice: true, signedIn: true, here: true, voiceSilenceMs: 900, reason: null };

const fakeController = () => createVoiceController({
  api: {
    readiness: async () => READY,
    start: async () => 'conv_1',
    end: async () => {},
    transcribe: async () => ({ text: '', heard: 'heard_1' }),
    synthesize: async () => {
      throw new Error('not in this test');
    },
    turn: async function* () {
      yield { type: 'done' };
    },
  },
  listen: async () => ({ destroy: () => {} }),
  createPlayer: () => ({ player: { play: async () => {}, drained: async () => {}, stop: () => {}, busy: false }, close: () => {} }),
  context: () => ({}),
  queue: async () => true,
  speech: { readOffer: async () => null, followPort: () => {}, readLocalModelInstalled: async () => null, applyFirstRun: async () => {} },
  savedChoices: () => ({ vscode: false, savedSttProvider: true, savedVoiceProvider: true, localModelSaved: false }),
  firstRunMark: { applied: () => true, apply: () => {} },
  startSpeechState: () => () => {},
  watchAccount: () => () => {},
  account: () => 'u1',
  window: Object.assign(new EventTarget(), { setInterval: () => 0, clearInterval: () => {} }),
});

describe('the voice root', () => {
  test('the main window and the mini chat each mount the voice root, behind its own error boundary', () => {
    for (const surface of ['main', 'mini-chat'] as const) {
      const root = MittrRoot({ children: null, surface });
      if (!React.isValidElement<{ children: React.ReactNode }>(root)) throw new Error('MittrRoot did not return an element');
      const gate = React.Children.toArray(root.props.children).find((child) => React.isValidElement(child) && child.type === MittrSignInGate);
      if (!React.isValidElement<{ children: React.ReactNode }>(gate)) throw new Error('MittrRoot did not wrap the sign-in gate');
      expect(React.Children.toArray(gate.props.children).some((child) => React.isValidElement(child) && child.type === MittrVoiceMount)).toBe(true);
    }
    const mounted = MittrVoiceMount();
    if (!React.isValidElement<{ children: React.ReactNode }>(mounted)) throw new Error('the voice mount renders nothing');
    expect(mounted.type).toBe(MittrErrorBoundary);
    const inner = mounted.props.children;
    expect(React.isValidElement(inner) && inner.type === MittrVoiceRoot).toBe(true);
  });

  test('an open conversation puts the voice bar on the page and End closes it', async () => {
    const controller = fakeController();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<MittrVoiceRoot createController={() => controller} />));
    expect(document.body.innerHTML).not.toContain('aria-label="Voice assistant"');
    await act(async () => {
      controller.toggle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.innerHTML).toBe('');
    expect(document.body.innerHTML).toContain('aria-label="Voice assistant"');
    await act(async () => controller.end());
    expect(document.body.innerHTML).not.toContain('aria-label="Voice assistant"');
    await act(async () => root.unmount());
  });
});

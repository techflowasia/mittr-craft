import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';

import type { RuntimeAPIs } from '@/lib/api/types';
import type { AssistantMessage, Message, Part } from '@/lib/opencode/model';
import type { TurnGroupingContext } from './lib/turns/types';

plugin({
  name: 'chat-message-vite-imports',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
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
const { registerProductUiPlugin, resetProductUiPluginsForTests } = await import('@/lib/product-plugins');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { SyncProvider } = await import('@/sync/sync-context');
const { default: ChatMessage } = await import('./ChatMessage');

const unavailable = (): never => { throw new Error('rendering a message must not call runtime APIs'); };
const runtimeApis: RuntimeAPIs = {
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  get terminal() { return unavailable(); },
  get git() { return unavailable(); },
  get sourceControl() { return unavailable(); },
  get files() { return unavailable(); },
  get settings() { return unavailable(); },
  get permissions() { return unavailable(); },
  get notifications() { return unavailable(); },
};
const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }) });

const assistant = (error?: AssistantMessage['error']): AssistantMessage => {
  const info: AssistantMessage = {
    id: 'msg_reply',
    sessionID: 'ses_probe',
    role: 'assistant',
    time: { created: 2, completed: 3 },
    agent: 'build',
    providerID: 'probe',
    modelID: 'probe-model',
    finish: error ? 'error' : 'stop',
  };
  if (error) info.error = error;
  return info;
};

const user: Message = { id: 'msg_ask', sessionID: 'ses_probe', role: 'user', time: { created: 1 } };

const textPart = (messageID: string, text: string): Part => ({
  id: `${messageID}:text:0`,
  sessionID: 'ses_probe',
  messageID,
  type: 'text',
  text,
});

const turn = (isLatestTurn: boolean): TurnGroupingContext => ({
  turnId: 'msg_ask',
  isFirstAssistantInTurn: true,
  isLastAssistantInTurn: true,
  isLatestTurn,
  isWorking: false,
  hasTools: false,
  hasReasoning: false,
});

const render = async (message: { info: Message; parts: Part[] }, context?: TurnGroupingContext): Promise<string> => {
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
                <ChatMessage message={message} turnGroupingContext={context} />
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

const refused = { type: 'probe.refused', message: 'raw refusal', status: 402, response: { body: '{"reason":"probe"}' } };

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

describe('ChatMessage product hooks', () => {
  test('a product error translation replaces the error text', async () => {
    const seen: unknown[] = [];
    registerProductUiPlugin({
      id: 'error-probe',
      messageError: (error) => {
        seen.push(error);
        return error.type === 'probe.refused' ? 'Product refusal text' : null;
      },
    });
    const html = await render({ info: assistant(refused), parts: [] }, turn(true));
    expect(html).toContain('Product refusal text');
    expect(html).not.toContain('Opencode failed to send message with error');
    expect(seen.at(-1)).toEqual({ type: 'probe.refused', message: 'raw refusal', status: 402, responseBody: '{"reason":"probe"}', providerID: 'probe' });
  });

  test('an error the plugin does not translate keeps the upstream text', async () => {
    registerProductUiPlugin({ id: 'error-probe', messageError: () => null });
    const html = await render({ info: assistant(refused), parts: [] }, turn(true));
    expect(html).toContain('Opencode failed to send message with error: raw refusal');
  });

  test('the footer slot receives the message and isLatestTurn', async () => {
    registerProductUiPlugin({
      id: 'footer-probe',
      slots: {
        'assistant-message-footer': ({ message, isLatestTurn }) => (
          <span data-probe="footer">{`${message.info.id}|${message.parts.length}|${String(isLatestTurn)}`}</span>
        ),
      },
    });
    const parts = [textPart('msg_reply', 'Here it is')];
    expect(await render({ info: assistant(), parts }, turn(true))).toContain('msg_reply|1|true');
    expect(await render({ info: assistant(), parts }, turn(false))).toContain('msg_reply|1|false');
    expect(await render({ info: assistant(), parts })).toContain('msg_reply|1|false');
    expect(await render({ info: user, parts: [textPart('msg_ask', 'Question')] }, turn(true))).not.toContain('data-probe');
  });

  test('with no plugin the footer slot renders nothing', async () => {
    const html = await render({ info: assistant(), parts: [textPart('msg_reply', 'Here it is')] }, turn(true));
    expect(html).toContain('Here it is');
    expect(html).not.toContain('data-probe');
  });
});

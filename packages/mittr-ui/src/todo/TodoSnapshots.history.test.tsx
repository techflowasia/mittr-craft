import { act } from 'react';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from '../../../ui/node_modules/happy-dom';
import { OpenCode } from '@opencode/client';

import { I18nProvider } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import type { AssistantMessage, Part, Session } from '@/lib/opencode/model';
import { projectMessages } from '@/lib/opencode/projection';
import { toolContentShellChars } from '@/lib/opencode/toolContentShells';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { ChatColumnSessionContext } from '@/components/chat/chatColumnSession';
import { parsePartShellsHeader, shellMessagePage } from '../../../web/server/lib/opencode/message-shells';
import { TodoSnapshots } from './TodoSnapshots';

const DIRECTORY = '/repo/chat';
const SESSION_ID = 'ses_1';
const MESSAGE_ID = 'msg_2';

const envelope = JSON.stringify({ schemaVersion: 1, ok: true, action: 'todo.write', data: { todos: [{ id: 'a', content: 'Inspect the code', status: 'pending' }] } });
type MessageRecords = Parameters<typeof projectMessages>[0];

type MessagePage = { data: MessageRecords; cursor: object };
type ProjectedMessage = { info: AssistantMessage; parts: Part[] };

const recorded: MessagePage = {
  data: [{
    id: MESSAGE_ID,
    type: 'assistant',
    time: { created: 1, completed: 2 },
    agent: 'build',
    model: { providerID: 'mittr', id: 'fast' },
    content: [{
      type: 'tool',
      id: 'call_1',
      name: 'mittrcraft_todo',
      time: { created: 1, ran: 1, completed: 2 },
      state: { status: 'completed', input: { action: 'todo.write', parameters: {} }, content: [{ type: 'text', text: envelope }], metadata: {} },
    }],
  }],
  cursor: {},
};

const keepWhole = parsePartShellsHeader('v1');
if (!keepWhole) throw new Error('the server no longer reads the part-shells header');
const project = (data: MessageRecords): ProjectedMessage => {
  const [record] = projectMessages(data, SESSION_ID);
  if (record?.message.role !== 'assistant') throw new Error('expected one assistant message');
  return { info: record.message, parts: record.parts };
};
const whole = project(recorded.data);
const shelledPage = shellMessagePage(recorded, keepWhole);
const shelled = project(shelledPage.data);

const session: Session = {
  id: SESSION_ID,
  projectID: 'project',
  directory: DIRECTORY,
  title: 'chat',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
};

let browser: Window;
let previous: Array<readonly [string, PropertyDescriptor | undefined]>;
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  browser = new Window({ url: 'http://localhost' });
  const globals = {
    window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
    customElements: browser.customElements, Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    fetch: async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.abort();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const settle = async () => {
  for (let turn = 0; turn < 20; turn += 1) await act(async () => { await Promise.resolve(); });
};

const show = async (parts: Part[]) => {
  const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }) });
  const tree = (shown: Part[] | null) => (
    <SyncProvider sdk={sdk} directory={DIRECTORY}>
      <I18nProvider>
        <ChatColumnSessionContext.Provider value={{ sessionId: SESSION_ID, directory: DIRECTORY }}>
          {shown ? <TodoSnapshots message={{ info: whole.info, parts: shown }} isLatestTurn={false} /> : null}
        </ChatColumnSessionContext.Provider>
      </I18nProvider>
    </SyncProvider>
  );
  await act(async () => { root.render(tree(null)); });
  const store = getSyncChildStores().ensureChild(DIRECTORY, { bootstrap: false });
  store.setState({ session: [session], message: { [SESSION_ID]: [whole.info] }, part: { [MESSAGE_ID]: parts } });
  await act(async () => { root.render(tree(parts)); });
  await settle();
  return { redraw: async () => { await act(async () => { root.render(tree(store.getState().part[MESSAGE_ID] ?? [])); }); } };
};

test('history empties a todo write result, so the checklist is read back and shown', async () => {
  expect(shelled.parts.some((part) => toolContentShellChars(part) !== null)).toBe(true);
  const read = spyOn(opencodeClient, 'getToolContentMessage').mockResolvedValue(whole);
  try {
    const view = await show(shelled.parts);
    expect(read.mock.calls).toEqual([[SESSION_ID, MESSAGE_ID, DIRECTORY]]);
    await view.redraw();
    expect(container.textContent).toContain('Inspect the code');
    expect(container.querySelectorAll('[data-todo-snapshot]')).toHaveLength(1);
  } finally {
    read.mockRestore();
  }
});

test('a checklist whose result is already here is shown without another read', async () => {
  const read = spyOn(opencodeClient, 'getToolContentMessage').mockResolvedValue(whole);
  try {
    await show(whole.parts);
    expect(read.mock.calls).toHaveLength(0);
    expect(container.textContent).toContain('Inspect the code');
  } finally {
    read.mockRestore();
  }
});

test('a result that cannot be read says so and can be read again', async () => {
  const read = spyOn(opencodeClient, 'getToolContentMessage').mockRejectedValueOnce(new Error('offline')).mockResolvedValue(whole);
  try {
    const view = await show(shelled.parts);
    expect(container.textContent).toContain("Couldn't load the result.");
    const retry = container.querySelector('button');
    await act(async () => { retry?.click(); });
    await settle();
    await view.redraw();
    expect(read.mock.calls).toHaveLength(2);
    expect(container.textContent).toContain('Inspect the code');
  } finally {
    read.mockRestore();
  }
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from '../../../ui/node_modules/happy-dom';
import { OpenCode } from '@opencode/client';

import { I18nProvider } from '../../../ui/src/lib/i18n';
import { I18nContext } from '../../../ui/src/lib/i18n/react-context';
import { dict as french } from '../../../ui/src/lib/i18n/messages/fr';
import type { AssistantMessage, Message, Part, ToolPart } from '../../../ui/src/lib/opencode/model';
import { SyncProvider } from '../../../ui/src/sync/sync-context';
import { TodoSnapshots } from './TodoSnapshots';
import { isChecklistReplaced, todoSnapshotOf } from './readTodoSnapshot';

const info: AssistantMessage = {
  id: 'msg_1', sessionID: 'ses_1', role: 'assistant', time: { created: 1 },
  agent: 'build', providerID: 'mittr', modelID: 'model_1',
};
const todos = [
  { id: 'a', content: 'Inspect the code', status: 'completed' },
  { id: 'b', content: 'Run the tests', status: 'in_progress' },
  { id: 'c', content: 'Check mobile', status: 'pending' },
  { id: 'd', content: 'Old approach', status: 'cancelled' },
];
const envelope = { schemaVersion: 1, ok: true, action: 'todo.write', data: { todos } };
const write = (id = 'part_1', output = JSON.stringify(envelope)): ToolPart => ({
  id, sessionID: info.sessionID, messageID: info.id, type: 'tool', callID: `call_${id}`, tool: 'mittrcraft_todo',
  state: { status: 'completed', input: { action: 'todo.write', parameters: { todos } }, output, time: { start: 1, end: 2 } },
});
const browser = new Window({ url: 'http://localhost' });
const globals = {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  customElements: browser.customElements, Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  fetch: async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);

beforeAll(() => {
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
});

afterAll(async () => {
  await browser.happyDOM.abort();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const draw = async (content: React.ReactNode): Promise<string> => {
  const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }) });
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => { root.render(<SyncProvider sdk={sdk} directory="/repo/chat">{content}</SyncProvider>); });
  const html = host.innerHTML;
  await act(async () => { root.unmount(); });
  return html;
};

const render = (parts: Part[], messageInfo = info) => draw(
  <I18nProvider><TodoSnapshots message={{ info: messageInfo, parts }} isLatestTurn={false} /></I18nProvider>,
);

describe('todo write snapshots', () => {
  test('reads the actual tools callback success envelope, not the input or bare JSON', () => {
    expect(todoSnapshotOf(write())).toEqual(todos);
    for (const output of [JSON.stringify({ todos }), JSON.stringify(todos), '{', '', JSON.stringify({ ...envelope, ok: false }), JSON.stringify({ ...envelope, action: 'todo.read' }), JSON.stringify({ ...envelope, schemaVersion: 2 })]) {
      expect(todoSnapshotOf(write('p', output))).toBeNull();
    }
  });

  test('accepts the registry-supported write alias only with a successful canonical write result', async () => {
    const part = write();
    const alias: ToolPart = { ...part, state: { ...part.state, input: { action: 'write', parameters: { todos } } } };
    expect(todoSnapshotOf(alias)).toEqual(todos);
    expect(await render([alias])).toContain('Inspect the code');
    const readAlias: ToolPart = { ...part, state: { ...part.state, input: { action: 'read' } } };
    expect(todoSnapshotOf(readAlias)).toBeNull();
    expect(todoSnapshotOf(write('alias', JSON.stringify({ ...envelope, action: 'write' })))).toBeNull();
  });

  test('does not render read, other tools, pending, running, errors, or prose', async () => {
    const part = write();
    expect(await render([
      { ...part, tool: 'other_tool' },
      { ...part, state: { ...part.state, input: { action: 'todo.read' } } },
      { ...part, state: { status: 'pending', input: { action: 'todo.write' }, raw: '' } },
      { ...part, state: { status: 'running', input: { action: 'todo.write' }, time: { start: 1 } } },
      { ...part, state: { status: 'error', input: { action: 'todo.write' }, error: 'Failed', output: JSON.stringify(envelope), time: { start: 1, end: 2 } } },
      { id: 'text', sessionID: info.sessionID, messageID: info.id, type: 'text', text: JSON.stringify(envelope) },
    ])).toBe('');
  });

  test('rejects incomplete, duplicate, and invalid todos without showing a partial snapshot', () => {
    for (const invalid of [[{ id: 'a', content: 'x' }], [{ id: 'a', content: '', status: 'pending' }], [{ id: 'a', content: 'x', status: 'done' }], [todos[0], todos[0]]]) {
      expect(todoSnapshotOf(write('p', JSON.stringify({ ...envelope, data: { todos: invalid } })))).toBeNull();
    }
  });

  test('shows the last checklist of a message once, with its progress, and every status in words', async () => {
    const done = JSON.stringify({ ...envelope, data: { todos: todos.map((item) => ({ ...item, status: 'completed' })) } });
    const html = await render([write('first', done), write('second')]);
    expect(html).not.toContain('data-todo-snapshot="first"');
    expect(html).toContain('data-todo-snapshot="second"');
    expect(html).toContain('1/4');
    expect(html).toContain('Completed: 1, Total: 4');
    for (const status of ['Pending', 'In progress', 'Completed', 'Cancelled']) expect(html).toContain(status);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain('aria-label="Tasks"');
    expect(await render([write('first'), write('cleared', JSON.stringify({ ...envelope, data: { todos: [] } }))])).toContain('0/0');
  });

  test('a write that failed does not take the place of the last checklist that was saved', async () => {
    const html = await render([write('saved'), write('refused', JSON.stringify({ ...envelope, ok: false }))]);
    expect(html).toContain('data-todo-snapshot="saved"');
  });

  test('a later checklist in the same turn replaces the earlier one, and one in another turn does not', () => {
    const message = (id: string, role: Message['role']): Message => (role === 'user'
      ? { id, sessionID: info.sessionID, role, time: { created: 1 } }
      : { ...info, id });
    const at = (id: string): Part => ({ ...write(id), messageID: id });
    const turns = [message('ask_1', 'user'), message('one', 'assistant'), message('two', 'assistant'), message('answer', 'assistant'), message('ask_2', 'user'), message('three', 'assistant')];
    const parts: Record<string, Part[]> = { one: [at('one')], two: [at('two')], three: [at('three')] };
    const replaced = (id: string) => isChecklistReplaced(id, turns, (messageID) => parts[messageID] ?? []);
    expect(['one', 'two', 'three'].map(replaced)).toEqual([true, false, false]);
    expect(isChecklistReplaced('missing', turns, () => [])).toBe(false);
    parts.two = [{ ...write('two', JSON.stringify({ ...envelope, ok: false })), messageID: 'two' }];
    expect(replaced('one')).toBe(false);
  });

  test('uses the active UI locale for titles and every accessible status', async () => {
    const html = await draw(
      <I18nContext.Provider value={{ locale: 'fr', locales: ['fr'], direction: 'ltr', setLocale: () => {}, label: () => 'Français', t: (key) => french[key] }}>
        <TodoSnapshots message={{ info, parts: [write()] }} isLatestTurn={false} />
      </I18nContext.Provider>,
    );
    for (const text of ['Tâches', 'En attente', 'En cours', 'Terminé', 'Annulé']) expect(html).toContain(text);
  });

  test('cannot leak snapshots across sessions or messages and escapes generated content', async () => {
    expect(await render([write()], { ...info, sessionID: 'ses_other' })).toBe('');
    expect(await render([write()], { ...info, id: 'msg_other' })).toBe('');
    const html = await render([write('p', JSON.stringify({ ...envelope, data: { todos: [{ ...todos[0], content: '<script>alert(1)</script>' }] } }))]);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(await render([write()])).toContain('Inspect the code');
    expect(await render([])).toBe('');
  });
});

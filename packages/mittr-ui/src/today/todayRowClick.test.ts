import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Window } from '../../../ui/node_modules/happy-dom';

const browser = new Window({ url: 'http://localhost/' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({ document: browser.document, Element: browser.Element })) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

afterAll(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const { isSessionOpenClick } = await import('./todayRowClick');

const row = (selectionMode = false) => {
  const host = document.createElement('div');
  host.innerHTML = `
    <div data-session-row="ses_1">
      <span role="button" aria-label="Expand" data-part="chevron"></span>
      <div><div role="button" tabindex="0" data-session-row-main="" ${selectionMode ? 'aria-pressed="false"' : ''} data-part="title"><span data-part="title-text">Room</span><button type="button" data-part="mark">Guest</button></div></div>
      <div><input data-part="rename" /></div>
      <div data-part="actions"><button type="button" aria-label="Add to my work" data-part="work"></button><button type="button" aria-label="Session menu" aria-haspopup="menu" data-part="menu"></button></div>
      <span data-part="gutter"></span>
    </div>`;
  document.body.append(host);
  const part = (name: string) => host.querySelector(`[data-part="${name}"]`);
  return { part, remove: () => host.remove() };
};

describe('Minor 8: which clicks on a sidebar row close Today', () => {
  test('opening the row closes it: its title or the row around it', () => {
    const view = row();
    for (const name of ['title', 'title-text', 'gutter']) expect(isSessionOpenClick(view.part(name))).toBe(true);
    view.remove();
  });

  test('the row actions, its menu, a control inside the title, the subsession chevron and renaming leave Today open', () => {
    const view = row();
    for (const name of ['chevron', 'rename', 'work', 'menu', 'mark']) expect(isSessionOpenClick(view.part(name))).toBe(false);
    view.remove();
  });

  test('in selection mode, ticking rows leaves Today open', () => {
    const view = row(true);
    for (const name of ['title', 'title-text', 'gutter']) expect(isSessionOpenClick(view.part(name))).toBe(false);
    view.remove();
  });

  test('a click outside any row does nothing', () => {
    expect(isSessionOpenClick(document.body)).toBe(false);
    expect(isSessionOpenClick(null)).toBe(false);
  });
});

const upstream = (path: string): string => readFileSync(new URL(`../../../ui/src/components/${path}`, import.meta.url), 'utf8');

const mount = (html: string) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  const part = (name: string) => host.querySelector(`[data-part="${name}"]`);
  return { part, remove: () => host.remove() };
};

const workRow = () => mount(`
  <div class="group/work relative my-0.5 flex" data-part="box">
    <span><span role="button" aria-label="Collapse" aria-expanded="true" data-part="chevron"></span></span>
    <div role="button" tabindex="0" aria-label="Open work"><span data-part="title">Branch</span><span><button type="button" data-part="pr">#12</button></span></div>
    <form><input data-part="rename" /></form>
    <div><button type="button" aria-label="Track" data-part="track"></button><button type="button" data-part="new"></button><button type="button" aria-haspopup="menu" data-part="menu"></button></div>
    <span data-part="gutter"></span>
  </div>`);

const draftRow = () => mount(`
  <div class="group/draft relative my-0.5 flex" data-part="box">
    <div><div role="button" tabindex="0" aria-label="Open draft"><span data-part="title">Draft</span></div></div>
    <div><button type="button" aria-label="Discard" data-part="discard"></button></div>
    <span data-part="gutter"></span>
  </div>`);

const tab = (active: boolean, inner = '<span data-part="title">Room</span>') => mount(`
  <div class="app-region-no-drag session-tab-slot flex" data-active="${active}" role="button" data-part="slot">
    <div role="tab" data-part="tab"><button type="button" aria-label="Close tab" data-part="close"></button>${inner}</div>
  </div>`);

describe('rows and tabs that open what is already open', () => {
  test('upstream still marks the rows and the active tab the way they are found here', () => {
    expect(upstream('session/sidebar/works/WorktreeWorkRow.tsx')).toContain("'group/work relative");
    expect(upstream('session/sidebar/works/WorktreeWorkRow.tsx').split('aria-expanded={expanded}').length - 1).toBe(2);
    expect(upstream('session/sidebar/works/SessionDraftRow.tsx')).toContain("'group/draft relative");
    const strip = upstream('layout/SessionTabsStrip.tsx');
    expect(strip).toContain("data-active={isActive ? 'true' : 'false'}");
    expect(strip.split('session-tab-slot').length - 1).toBe(3);
    expect(strip.split('data-active="true"').length - 1).toBe(2);
  });

  test('a worktree row closes Today from its title or the row around it, and not from its own buttons', () => {
    const view = workRow();
    for (const name of ['title', 'gutter', 'box']) expect(isSessionOpenClick(view.part(name))).toBe(true);
    for (const name of ['chevron', 'pr', 'rename', 'track', 'new', 'menu']) expect(isSessionOpenClick(view.part(name))).toBe(false);
    view.remove();
  });

  test('a draft row closes Today from its title or the row around it, and not from its discard button', () => {
    const view = draftRow();
    for (const name of ['title', 'gutter', 'box']) expect(isSessionOpenClick(view.part(name))).toBe(true);
    expect(isSessionOpenClick(view.part('discard'))).toBe(false);
    view.remove();
  });

  test('the active session tab closes Today, and not from its close button or while it is being renamed', () => {
    const view = tab(true);
    for (const name of ['title', 'tab', 'slot']) expect(isSessionOpenClick(view.part(name))).toBe(true);
    expect(isSessionOpenClick(view.part('close'))).toBe(false);
    view.remove();
    const renaming = tab(true, '<form><input data-part="rename" /><button type="submit" data-part="save"></button></form>');
    for (const name of ['rename', 'save']) expect(isSessionOpenClick(renaming.part(name))).toBe(false);
    renaming.remove();
  });

  test('another tab is left to the selection it changes', () => {
    const view = tab(false);
    expect(isSessionOpenClick(view.part('title'))).toBe(false);
    view.remove();
  });

  test('a click that marks a row or tab read, or opens the tab beside the chat, leaves Today open', () => {
    const work = workRow();
    expect(isSessionOpenClick(work.part('title'), { altKey: true, shiftKey: false })).toBe(false);
    expect(isSessionOpenClick(work.part('title'), { altKey: false, shiftKey: true })).toBe(true);
    work.remove();
    const view = tab(true);
    expect(isSessionOpenClick(view.part('title'), { altKey: true, shiftKey: false })).toBe(false);
    expect(isSessionOpenClick(view.part('title'), { altKey: false, shiftKey: true })).toBe(false);
    view.remove();
    const session = row();
    expect(isSessionOpenClick(session.part('title'), { altKey: true, shiftKey: false })).toBe(false);
    expect(isSessionOpenClick(session.part('title'), { altKey: false, shiftKey: true })).toBe(false);
    session.remove();
  });
});

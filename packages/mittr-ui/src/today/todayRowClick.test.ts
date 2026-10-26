import { afterAll, describe, expect, test } from 'bun:test';
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
      <div><button type="button" ${selectionMode ? 'aria-pressed="false"' : ''} data-part="title"><span data-part="title-text">Room</span></button></div>
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

  test('the row actions, its menu, the subsession chevron and renaming leave Today open', () => {
    const view = row();
    for (const name of ['chevron', 'rename', 'work', 'menu']) expect(isSessionOpenClick(view.part(name))).toBe(false);
    view.remove();
  });

  test('in selection mode, ticking rows leaves Today open', () => {
    const view = row(true);
    for (const name of ['title', 'gutter']) expect(isSessionOpenClick(view.part(name))).toBe(false);
    view.remove();
  });

  test('a click outside any row does nothing', () => {
    expect(isSessionOpenClick(document.body)).toBe(false);
    expect(isSessionOpenClick(null)).toBe(false);
  });
});

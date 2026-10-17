import React, { act } from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';

mock.module('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
mock.module('@/components/ui/ScrollableOverlay', () => ({
  ScrollableOverlay: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));
mock.module('@/components/ui/ProviderLogo', () => ({ ProviderLogo: () => null }));
mock.module('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));

const { ModelPickerList } = await import('./ModelPickerList');
type ListProps = React.ComponentProps<typeof ModelPickerList>;

const PROVIDERS: ListProps['providers'] = [{
  id: 'mittr',
  name: 'Mittr',
  models: [{ id: 'writer', name: 'Mittr Writer' }, { id: 'analyst', name: 'Mittr Analyst' }],
}];

const LABELS: ListProps['labels'] = {
  searchPlaceholder: 'Search models',
  noResults: 'No models',
  favorites: 'Favorites',
  recent: 'Recent',
  keyboardHint: 'Navigate',
};

const isWriter: NonNullable<ListProps['isEntryBlocked']> = (entry) => entry.modelID === 'writer';

const listProps = (over: Partial<ListProps> = {}): ListProps => ({
  providers: PROVIDERS,
  favoriteModels: [],
  recentModels: [],
  searchQuery: '',
  onSearchQueryChange: () => {},
  onSelect: () => {},
  labels: LABELS,
  stickyHeaders: false,
  ...over,
});

const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'KeyboardEvent',
  'MouseEvent',
  'localStorage',
  'requestAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

let restoreDom: (() => void) | null = null;

afterEach(() => {
  restoreDom?.();
  restoreDom = null;
});

const installDom = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    Node: happyWindow.Node,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    KeyboardEvent: happyWindow.KeyboardEvent,
    MouseEvent: happyWindow.MouseEvent,
    localStorage: happyWindow.localStorage,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      happyWindow.setTimeout(() => callback(0), 0);
      return 0;
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }
  restoreDom = () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container };
};

const mountList = async (props: ListProps) => {
  const dom = installDom();
  const root = createRoot(dom.container);
  await act(async () => root.render(<ModelPickerList {...props} />));
  const rows = [...dom.container.querySelectorAll('[role="option"]')];
  const rowOf = (name: string) => {
    const row = rows.find((candidate) => candidate.textContent?.includes(name));
    if (!row) throw new Error(`no row for ${name}`);
    return row;
  };
  const press = async (target: Element, key: string) => {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
  };
  const click = async (target: Element) => {
    await act(async () => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };
  return {
    rowOf,
    press,
    click,
    search: () => {
      const input = dom.container.querySelector('input');
      if (!input) throw new Error('no search field');
      return input;
    },
    unmount: () => act(async () => root.unmount()),
  };
};

describe('ModelPickerList blocked entries', () => {
  test('a blocked entry cannot be chosen by click, Enter or Space', async () => {
    const chosen: string[] = [];
    const picker = await mountList(listProps({
      isEntryBlocked: isWriter,
      onSelect: (entry) => chosen.push(entry.modelID),
    }));
    const writer = picker.rowOf('Mittr Writer');

    await picker.click(writer);
    await picker.press(writer, 'Enter');
    await picker.press(writer, ' ');
    expect(chosen).toEqual([]);

    await picker.press(picker.search(), 'Enter');
    expect(chosen).toEqual([]);

    await picker.unmount();
  });

  test('the highlighted blocked entry is not chosen by Enter in the search field either', async () => {
    const chosen: string[] = [];
    const picker = await mountList(listProps({
      isEntryBlocked: isWriter,
      onSelect: (entry) => chosen.push(entry.modelID),
      selectedModel: { providerID: 'mittr', modelID: 'writer' },
    }));
    await picker.press(picker.search(), 'Enter');
    expect(chosen).toEqual([]);

    await picker.press(picker.search(), 'ArrowDown');
    await picker.press(picker.search(), 'Enter');
    expect(chosen).toEqual(['analyst']);
    await picker.unmount();
  });

  test('an entry that is not blocked is still chosen by click, Enter and Space', async () => {
    const chosen: string[] = [];
    const picker = await mountList(listProps({
      isEntryBlocked: isWriter,
      onSelect: (entry) => chosen.push(entry.modelID),
    }));
    const analyst = picker.rowOf('Mittr Analyst');

    await picker.click(analyst);
    await picker.press(analyst, 'Enter');
    await picker.press(analyst, ' ');
    expect(chosen).toEqual(['analyst', 'analyst', 'analyst']);
    await picker.unmount();
  });

  test('a blocked row is marked aria-disabled and an open row is not', () => {
    const html = renderToStaticMarkup(<ModelPickerList {...listProps({ isEntryBlocked: isWriter })} />);
    const rows = html.split('role="option"').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Mittr Writer');
    expect(rows[0]).toContain('aria-disabled="true"');
    expect(rows[1]).toContain('Mittr Analyst');
    expect(rows[1]).not.toContain('aria-disabled');
  });

  test('without isEntryBlocked nothing changes', async () => {
    const html = renderToStaticMarkup(<ModelPickerList {...listProps()} />);
    expect(html).not.toContain('aria-disabled');

    const chosen: string[] = [];
    const picker = await mountList(listProps({ onSelect: (entry) => chosen.push(entry.modelID) }));
    const writer = picker.rowOf('Mittr Writer');
    await picker.click(writer);
    await picker.press(writer, 'Enter');
    await picker.press(writer, ' ');
    expect(chosen).toEqual(['writer', 'writer', 'writer']);
    await picker.unmount();
  });

  test('the whole list being disabled still blocks every row', () => {
    const html = renderToStaticMarkup(<ModelPickerList {...listProps({ disabled: true, isEntryBlocked: isWriter })} />);
    const rows = html.split('role="option"').slice(1);
    expect(rows.every((row) => row.includes('aria-disabled="true"'))).toBe(true);
  });
});

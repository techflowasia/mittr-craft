import { afterAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from '../../../ui/node_modules/happy-dom';

const browser = new Window({ url: 'http://localhost/' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  fetch: () => new Promise<Response>(() => {}),
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
const { useProjectsStore } = await import('../../../ui/src/stores/useProjectsStore');
const { MittrProjectFolderNotice, ProjectFolderWatch } = await import('./MittrProjectFolderNotice');
const { offerLine, outcomeLine } = await import('./projectFolderNotice');

describe('the .mittr copy notice text', () => {
  test('offers the copy and promises nothing is moved or deleted', () => {
    expect(offerLine({ files: ['agents/a.md', 'skills/s/SKILL.md'] })).toEqual({
      title: 'This project keeps agents, commands or skills in .mittr',
      description: 'MittrCraft now reads them from .opencode. Copy 2 files from .mittr to .opencode? Nothing is moved or deleted, and files already in .opencode stay as they are.',
    });
    expect(offerLine({ files: ['agents/a.md'] }).description).toContain('Copy 1 file from .mittr');
  });

  test('names every file it skipped', () => {
    expect(outcomeLine({ kind: 'copied', copied: ['command/ship.md', 'skills/s/SKILL.md'], skipped: ['agents/review.md'] })).toEqual({
      failed: false,
      title: 'Copied 2 files to .opencode',
      description: 'Skipped because .opencode already has them: .opencode/agents/review.md',
    });
    expect(outcomeLine({ kind: 'copied', copied: ['a/b.md'], skipped: [] })).toEqual({ failed: false, title: 'Copied 1 file to .opencode' });
    expect(outcomeLine({ kind: 'copied', copied: [], skipped: ['a/b.md'] }).title).toBe('Nothing was copied to .opencode');
    expect(outcomeLine({ kind: 'failed', reason: 'No room' })).toEqual({ failed: true, title: 'Could not copy .mittr to .opencode', description: 'No room' });
  });
});

describe('when the notice looks', () => {
  test('it checks the selected project, and again when another one is selected', async () => {
    const checked: Array<string | null> = [];
    useProjectsStore.setState({ projects: [{ id: 'a', path: '/work/a' }, { id: 'b', path: '/work/b' }], activeProjectId: 'a' });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(<ProjectFolderWatch createNotice={() => ({ check: async (directory) => { checked.push(directory); } })} />);
    });
    await act(async () => {
      useProjectsStore.setState({ activeProjectId: 'b' });
    });
    await act(async () => root.unmount());
    expect(checked).toEqual(['/work/a', '/work/b']);
  });

  test('the mini chat never shows it', () => {
    expect(renderToStaticMarkup(<MittrProjectFolderNotice surface="mini-chat" />)).toBe('');
  });
});

import { afterAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from '../../../ui/node_modules/happy-dom';

import type { GoWorkProject, GoWorkSelection } from '../work/goWork';
import { planLaunch, runLaunch, type LaunchDeps, type LaunchTexts } from './todayLaunch';

const PROJECT: GoWorkProject = { id: 'proj_1', path: '/work/app', label: 'App' };
const SELECTION: GoWorkSelection = { providerID: 'acme', modelID: 'acme-1', agentName: 'build' };
const TEXTS: LaunchTexts = {
  'no-project': 'Choose a project first.',
  'no-model': 'Select a provider and model before sending.',
  'no-mittr-model': 'No Mittr model is available to you this week.',
  failed: 'Failed to send message',
};

const recorder = (created: { id: string; directory?: string | null } | null = { id: 'ses_new', directory: '/work/app' }) => {
  const calls: string[] = [];
  const deps: LaunchDeps = {
    createSession: async (directory, selection) => { calls.push(`create:${directory}:${selection.modelID}`); return created; },
    initialize: (id) => { calls.push(`initialize:${id}`); },
    sendMessage: async (text, selection, id, directory) => { calls.push(`send:${text}:${selection.agentName}:${id}:${directory}`); },
    openDraft: (text, project) => { calls.push(`draft:${text}:${project?.id ?? ''}`); },
    keepText: (text) => { calls.push(`keep:${text}`); },
    hide: () => { calls.push('hide'); },
    refuse: (message) => { calls.push(`refuse:${message}`); },
    fail: (message) => { calls.push(`fail:${message}`); },
  };
  return { calls, deps };
};

describe('starting a room from Today', () => {
  test('with no project, the refusal is shown and a draft opens with the text kept', async () => {
    const { calls, deps } = recorder();
    const result = await runLaunch(planLaunch({ text: 'Check the build', project: null, selection: SELECTION, available: true }), deps, TEXTS);
    expect(result).toBe('refused');
    expect(calls).toEqual(['refuse:Choose a project first.', 'draft:Check the build:', 'hide']);
  });

  test("with no model, the composer's own refusal is shown and the draft keeps the text in that project", async () => {
    const { calls, deps } = recorder();
    await runLaunch(planLaunch({ text: 'Check the build', project: PROJECT, selection: null, available: null }), deps, TEXTS);
    expect(calls).toEqual(['refuse:Select a provider and model before sending.', 'draft:Check the build:proj_1', 'hide']);
  });

  test('a blocked Mittr model is refused the same way', async () => {
    const { calls, deps } = recorder();
    await runLaunch(planLaunch({ text: 'Hi', project: PROJECT, selection: SELECTION, available: false }), deps, TEXTS);
    expect(calls[0]).toBe('refuse:No Mittr model is available to you this week.');
    expect(calls).toContain('draft:Hi:proj_1');
  });

  test('with a project and a model, a new room opens there and the text is sent with the default agent', async () => {
    const { calls, deps } = recorder();
    const result = await runLaunch(planLaunch({ text: 'Check the build', project: PROJECT, selection: SELECTION, available: true }), deps, TEXTS);
    expect(result).toBe('started');
    expect(calls).toEqual(['create:/work/app:acme-1', 'initialize:ses_new', 'hide', 'send:Check the build:build:ses_new:/work/app']);
  });

  test('a room that cannot be made keeps the text in a draft', async () => {
    const { calls, deps } = recorder(null);
    expect(await runLaunch(planLaunch({ text: 'Hi', project: PROJECT, selection: SELECTION, available: true }), deps, TEXTS)).toBe('failed');
    expect(calls).toEqual(['create:/work/app:acme-1', 'fail:Failed to send message', 'draft:Hi:proj_1', 'hide']);
  });

  test('a send that fails keeps the text in the new room', async () => {
    const { calls, deps } = recorder();
    deps.sendMessage = async () => { throw new Error('offline'); };
    expect(await runLaunch(planLaunch({ text: 'Hi', project: PROJECT, selection: SELECTION, available: true }), deps, TEXTS)).toBe('failed');
    expect(calls.slice(-2)).toEqual(['fail:Failed to send message', 'keep:Hi']);
  });
});

const browser = new Window({ url: 'http://localhost/' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  Node: browser.Node,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event,
  KeyboardEvent: browser.KeyboardEvent,
  MouseEvent: browser.MouseEvent,
  localStorage: browser.localStorage,
  getComputedStyle: browser.getComputedStyle.bind(browser),
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

describe('the Today chat box', () => {
  const mount = async () => {
    const { createRoot } = await import('react-dom/client');
    const { TodayLauncherView } = await import('./TodayLauncher');
    const launched: string[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<TodayLauncherView projects={[PROJECT]} project={PROJECT} onProject={() => {}} onLaunch={(text) => launched.push(text)} />);
    });
    const input = container.querySelector('textarea');
    if (!input) throw new Error('no chat box');
    const type = async (text: string) => act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value')?.set?.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const press = async (init: { shiftKey?: boolean; isComposing?: boolean } = {}) => act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));
    });
    const close = async () => { await act(async () => root.unmount()); container.remove(); };
    return { container, input, launched, type, press, close };
  };

  test('Enter sends the text, and the box shows the chosen project', async () => {
    const view = await mount();
    expect(view.container.textContent).toContain('App');
    await view.type('  Check the build  ');
    await view.press();
    expect(view.launched).toEqual(['Check the build']);
    expect(view.input.value).toBe('');
    await view.close();
  });

  test('Shift+Enter and an IME still composing do not send, and nothing empty is sent', async () => {
    const view = await mount();
    await view.press();
    await view.type('สวัสดี');
    await view.press({ shiftKey: true });
    await view.press({ isComposing: true });
    expect(view.launched).toEqual([]);
    await view.close();
  });
});

import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { WidgetsRequestError, type Widget, type WidgetsApi, type WidgetsList } from './widgetsApi';
import { createWidgetsController, widgetAlerts } from './widgetsController';
import { createWidgetsRegistration, registerWidgetsSection } from './widgetsRegistration';
import { WidgetsSection, WidgetsSectionView, type WidgetsActions } from './WidgetsSection';

const widget = (id: string, extra: Partial<Widget> = {}): Widget => ({
  id,
  title: `Widget ${id}`,
  display: 'number',
  source: { type: 'url', url: `https://data.example.test/${id}` },
  revision: `rev-${id}`,
  files: [],
  refreshMinutes: 15,
  enabled: true,
  alerting: false,
  ...extra,
});

const fakeApi = (answer: WidgetsList | 'absent' | Error) => {
  const calls: string[] = [];
  const api: WidgetsApi = {
    list: async () => {
      calls.push('list');
      if (answer instanceof Error) throw answer;
      return answer;
    },
    enable: async (id, revision) => { calls.push(`enable:${id}:${revision}`); return widget(id, { enabled: true }); },
    disable: async (id) => { calls.push(`disable:${id}`); return widget(id, { enabled: false }); },
    refresh: async (id) => { calls.push(`refresh:${id}`); return widget(id, { last: { at: 9, value: { kind: 'number', value: 7 } } }); },
    remove: async (id) => { calls.push(`remove:${id}`); return id; },
  };
  return { api, calls };
};

const noop = () => {};
const ACTIONS: WidgetsActions = { retry: noop, enable: noop, disable: noop, refresh: noop, remove: noop };

describe('the widgets section', () => {
  test('an empty list shows one line on asking Mittr', () => {
    const html = renderToStaticMarkup(<WidgetsSectionView state={{ status: 'ready', widgets: [], busy: [], switchedOn: true }} actions={ACTIONS} />);
    expect(html).toContain('Ask Mittr in any room to keep an eye on something for you, and its card appears here.');
    expect(html.split('<p').length - 1).toBe(1);
  });

  test('each widget gets its card', () => {
    const html = renderToStaticMarkup(<WidgetsSectionView state={{ status: 'ready', widgets: [widget('a'), widget('b', { enabled: false })], busy: [], switchedOn: true }} actions={ACTIONS} />);
    expect(html).toContain('Widget a');
    expect(html).toContain('Widget b');
    expect(html).toContain('>Turn on</button>');
  });

  test('a list that cannot be read shows the reason and a retry, never an empty hint', () => {
    const html = renderToStaticMarkup(<WidgetsSectionView state={{ status: 'error', error: 'Could not load your widgets' }} actions={ACTIONS} />);
    expect(html).toContain('Could not load your widgets');
    expect(html).toContain('>Try again</button>');
    expect(html).not.toContain('Ask Mittr');
  });

  test('an alerting widget becomes an alert on Today', () => {
    const opened: string[] = [];
    const rows = widgetAlerts([widget('a', { alerting: true }), widget('b')], () => { opened.push('widgets'); });
    expect(rows.map(({ id, kind, title, detail }) => ({ id, kind, title, detail }))).toEqual([
      { id: 'widget:a', kind: 'widget', title: 'Widget a', detail: 'Past its alert line' },
    ]);
    rows[0].open();
    expect(opened).toEqual(['widgets']);
  });

  test('the section renders nothing before it has loaded', () => {
    expect(renderToStaticMarkup(<WidgetsSection />)).toBe('');
  });
});

describe('the widgets controller', () => {
  test('it loads the list, and turning on calls the enable route and shows the answer', async () => {
    const { api, calls } = fakeApi({ widgets: [widget('a', { enabled: false })], switchedOn: true });
    const controller = createWidgetsController({ api });
    await controller.load();
    expect(controller.state()).toEqual({ status: 'ready', widgets: [widget('a', { enabled: false })], busy: [], switchedOn: true });
    expect(await controller.enable('a', 'rev-a')).toBeNull();
    expect(calls).toEqual(['list', 'enable:a:rev-a']);
    const state = controller.state();
    expect(state.status === 'ready' ? state.widgets[0].enabled : null).toBe(true);
  });

  test('remove sends DELETE and drops the card', async () => {
    const { api, calls } = fakeApi({ widgets: [widget('a'), widget('b')], switchedOn: true });
    const controller = createWidgetsController({ api });
    await controller.load();
    await controller.remove('a');
    expect(calls).toEqual(['list', 'remove:a']);
    const state = controller.state();
    expect(state.status === 'ready' ? state.widgets.map((entry) => entry.id) : []).toEqual(['b']);
  });

  test('C1: a click on a card Mittr changed since is refused, and the card then shows the new command', async () => {
    const changed = widget('a', { enabled: false, source: { type: 'command', command: 'cat other.txt', cwd: '/work/app' }, revision: 'rev-new' });
    let listed: Widget = widget('a', { enabled: false, source: { type: 'command', command: 'cat status.txt', cwd: '/work/app' }, revision: 'rev-old' });
    const { api, calls } = fakeApi({ widgets: [listed], switchedOn: true });
    api.list = async () => { calls.push('list'); return { widgets: [listed], switchedOn: true }; };
    api.enable = async (id, revision) => {
      calls.push(`enable:${id}:${revision}`);
      throw new WidgetsRequestError('This widget changed since you looked; check it again', 409);
    };
    const controller = createWidgetsController({ api });
    await controller.load();
    listed = changed;
    expect(await controller.enable('a', 'rev-old')).toBe('This widget changed since you looked; check it again');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(['list', 'enable:a:rev-old', 'list']);
    const state = controller.state();
    if (state.status !== 'ready') throw new Error('expected ready');
    expect(state.widgets[0].enabled).toBe(false);
    expect(state.widgets[0].revision).toBe('rev-new');
    const html = renderToStaticMarkup(<WidgetsSectionView state={state} actions={ACTIONS} />);
    expect(html).toContain('cat other.txt');
    expect(html).not.toContain('cat status.txt');
  });

  test('Minor 1: a runtime with no widget routes reads as absent and shows no panel, not an empty hint', async () => {
    const { api } = fakeApi('absent');
    const controller = createWidgetsController({ api });
    await controller.load();
    expect(controller.state()).toEqual({ status: 'absent' });
    expect(renderToStaticMarkup(<WidgetsSectionView state={{ status: 'absent' }} actions={ACTIONS} />)).toBe('');
  });

  test('Minor 18: after an account switch the old cards go away before the new list comes', async () => {
    const { api } = fakeApi({ widgets: [widget('a')], switchedOn: true });
    const controller = createWidgetsController({ api });
    await controller.load();
    const seen: string[] = [];
    controller.subscribe(() => { seen.push(controller.state().status); });
    await controller.reload();
    expect(seen).toEqual(['loading', 'ready']);
  });

  test('Minor 2: with the widgets switch off the section says so once, above the cards', () => {
    const html = renderToStaticMarkup(<WidgetsSectionView state={{ status: 'ready', widgets: [widget('a')], busy: [], switchedOn: false }} actions={ACTIONS} />);
    expect(html).toContain('Widgets are off in Settings → Integrations, so none of them runs.');
    expect(html.split('Widgets are off').length - 1).toBe(1);
  });

  test('a refused action answers its reason and reloads the list', async () => {
    const { api, calls } = fakeApi({ widgets: [widget('a', { enabled: false })], switchedOn: true });
    api.enable = async () => { throw new Error('The widgets tool is turned off in Settings → Integrations'); };
    const controller = createWidgetsController({ api });
    await controller.load();
    expect(await controller.enable('a', 'rev-a')).toBe('The widgets tool is turned off in Settings → Integrations');
    expect(calls.filter((call) => call === 'list').length).toBe(2);
  });
});

describe('registering the widgets section', () => {
  test('Minor 1: a runtime switch checks again, adding the panel on this Mac and removing it on a hosted runtime', async () => {
    let answer: WidgetsList | 'absent' = 'absent';
    const { api } = fakeApi('absent');
    api.list = async () => answer;
    const panels = new Set<string>();
    let changed: () => void = noop;
    const registration = createWidgetsRegistration({
      api,
      register: (name) => { panels.add(name); return () => { panels.delete(name); }; },
      subscribe: (onChange) => { changed = onChange; return noop; },
    });
    expect(await registration.ensure()).toBe(false);
    expect([...panels]).toEqual([]);
    answer = { widgets: [], switchedOn: true };
    changed();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([...panels]).toEqual(['widgets']);
    answer = 'absent';
    changed();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([...panels]).toEqual([]);
  });

  test('on a hosted runtime (no widget routes) the section is not registered', async () => {
    const registered: string[] = [];
    const { api } = fakeApi('absent');
    expect(await registerWidgetsSection({ api, register: (name) => { registered.push(name); return noop; } })).toBe(false);
    expect(registered).toEqual([]);
  });

  test('on this Mac the section is registered, even with no widgets yet', async () => {
    const registered: string[] = [];
    const { api } = fakeApi({ widgets: [], switchedOn: true });
    expect(await registerWidgetsSection({ api, register: (name, component) => { registered.push(`${name}:${component === WidgetsSection}`); return noop; } })).toBe(true);
    expect(registered).toEqual(['widgets:true']);
  });

  test('a client that is not this Mac (403) gets no panel either', async () => {
    const registered: string[] = [];
    const { api } = fakeApi(new WidgetsRequestError('Widgets can be seen and changed only on this Mac', 403));
    expect(await registerWidgetsSection({ api, register: (name) => { registered.push(name); return noop; } })).toBe(false);
    expect(registered).toEqual([]);
  });

  test('a list that fails for another reason still registers, so the panel can show the error', async () => {
    const registered: string[] = [];
    const { api } = fakeApi(new Error('Could not load your widgets'));
    expect(await registerWidgetsSection({ api, register: (name) => { registered.push(name); return noop; } })).toBe(true);
    expect(registered).toEqual(['widgets']);
  });
});

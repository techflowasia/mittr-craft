import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { WidgetsRequestError, type Widget, type WidgetsApi, type WidgetsList } from './widgetsApi';
import { createWidgetsController, widgetAlerts } from './widgetsController';
import { registerWidgetsSection } from './widgetsRegistration';
import { WidgetsSection, WidgetsSectionView, type WidgetsActions } from './WidgetsSection';

const widget = (id: string, extra: Partial<Widget> = {}): Widget => ({
  id,
  title: `Widget ${id}`,
  display: 'number',
  source: { type: 'url', url: `https://data.example.test/${id}` },
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
    enable: async (id) => { calls.push(`enable:${id}`); return widget(id, { enabled: true }); },
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
    const html = renderToStaticMarkup(<WidgetsSectionView state={{ status: 'ready', widgets: [], busy: [] }} actions={ACTIONS} />);
    expect(html).toContain('Ask Mittr in any room to keep an eye on something for you, and its card appears here.');
    expect(html.split('<p').length - 1).toBe(1);
  });

  test('each widget gets its card', () => {
    const html = renderToStaticMarkup(<WidgetsSectionView state={{ status: 'ready', widgets: [widget('a'), widget('b', { enabled: false })], busy: [] }} actions={ACTIONS} />);
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
    const { api, calls } = fakeApi({ widgets: [widget('a', { enabled: false })], canChange: true });
    const controller = createWidgetsController({ api });
    await controller.load();
    expect(controller.state()).toEqual({ status: 'ready', widgets: [widget('a', { enabled: false })], busy: [] });
    expect(await controller.enable('a')).toBeNull();
    expect(calls).toEqual(['list', 'enable:a']);
    const state = controller.state();
    expect(state.status === 'ready' ? state.widgets[0].enabled : null).toBe(true);
  });

  test('remove sends DELETE and drops the card', async () => {
    const { api, calls } = fakeApi({ widgets: [widget('a'), widget('b')], canChange: true });
    const controller = createWidgetsController({ api });
    await controller.load();
    await controller.remove('a');
    expect(calls).toEqual(['list', 'remove:a']);
    const state = controller.state();
    expect(state.status === 'ready' ? state.widgets.map((entry) => entry.id) : []).toEqual(['b']);
  });

  test('a refused action answers its reason and reloads the list', async () => {
    const { api, calls } = fakeApi({ widgets: [widget('a', { enabled: false })], canChange: true });
    api.enable = async () => { throw new Error('The widgets tool is turned off in Settings → Integrations'); };
    const controller = createWidgetsController({ api });
    await controller.load();
    expect(await controller.enable('a')).toBe('The widgets tool is turned off in Settings → Integrations');
    expect(calls.filter((call) => call === 'list').length).toBe(2);
  });
});

describe('registering the widgets section', () => {
  test('on a hosted runtime (no widget routes) the section is not registered', async () => {
    const registered: string[] = [];
    const { api } = fakeApi('absent');
    expect(await registerWidgetsSection({ api, register: (name) => { registered.push(name); return noop; } })).toBe(false);
    expect(registered).toEqual([]);
  });

  test('on this Mac the section is registered, even with no widgets yet', async () => {
    const registered: string[] = [];
    const { api } = fakeApi({ widgets: [], canChange: true });
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

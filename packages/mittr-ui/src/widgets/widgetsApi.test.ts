import type { JsonValue } from '@openchamber/sdk';
import { describe, expect, test } from 'bun:test';

import { createWidgetsApi, WidgetsRequestError, type WidgetsFetch } from './widgetsApi';

type Call = { path: string; method: string };

const respond = (status: number, body: JsonValue | 'not json') => {
  const calls: Call[] = [];
  const fetchImpl: WidgetsFetch = async (path, init) => {
    calls.push({ path, method: init?.method ?? 'GET' });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === 'not json') throw new SyntaxError('bad json');
        return body;
      },
    };
  };
  return { api: createWidgetsApi(fetchImpl), calls };
};

const COMMAND_WIDGET = {
  id: 'wid_0123456789abcdef',
  title: 'Jenkins dev build',
  display: 'status',
  source: { type: 'command', command: 'curl -s https://ci.example.test/job/dev/lastBuild/api/json | jq -r .result', cwd: '/work/app', extract: { regex: '(\\w+)', status: { ok: ['SUCCESS'], fail: ['FAILURE'] } } },
  refreshMinutes: 15,
  enabled: false,
  alerting: false,
};

const URL_WIDGET = {
  id: 'wid_fedcba9876543210',
  title: 'Headphone price',
  display: 'number',
  source: { type: 'url', url: 'https://shop.example.test/item/42', extract: { json: 'price' } },
  refreshMinutes: 60,
  alert: { op: 'below', value: 11500 },
  enabled: true,
  last: { at: 1792650000000, value: 12990 },
  alerting: false,
};

const refusedWith = async (work: Promise<object | string>, message: string, status: number | null) => {
  const error = await work.then(() => null, (caught: Error) => caught);
  expect(error).toBeInstanceOf(WidgetsRequestError);
  expect(error?.message).toBe(message);
  expect(error instanceof WidgetsRequestError ? error.status : undefined).toBe(status);
};

describe('the widgets API', () => {
  test('the list is read from GET /api/mittr/widgets with each widget as the server shapes it', async () => {
    const { api, calls } = respond(200, { widgets: [COMMAND_WIDGET, URL_WIDGET], canChange: true });
    const list = await api.list();
    expect(calls).toEqual([{ path: '/api/mittr/widgets', method: 'GET' }]);
    if (list === 'absent') throw new Error('expected a list');
    expect(list.canChange).toBe(true);
    expect(list.widgets.map((widget) => widget.id)).toEqual(['wid_0123456789abcdef', 'wid_fedcba9876543210']);
    const [command, url] = list.widgets;
    expect(command.source).toMatchObject({ type: 'command', command: COMMAND_WIDGET.source.command, cwd: '/work/app' });
    expect(url.source).toMatchObject({ type: 'url', url: 'https://shop.example.test/item/42' });
    expect(url.last).toEqual({ at: 1792650000000, value: { kind: 'number', value: 12990 } });
    expect(url.alert).toEqual({ op: 'below', value: 11500 });
  });

  test('a widget the UI cannot read is left out, the rest stay', async () => {
    const { api } = respond(200, { widgets: [COMMAND_WIDGET, { id: 'wid_broken' }], canChange: true });
    const list = await api.list();
    expect(list === 'absent' ? [] : list.widgets.map((widget) => widget.id)).toEqual(['wid_0123456789abcdef']);
  });

  test('a last run that failed carries its error', async () => {
    const { api } = respond(200, { widgets: [{ ...URL_WIDGET, last: { at: 5, error: 'Timed out after 20 s' } }], canChange: true });
    const list = await api.list();
    expect(list === 'absent' ? null : list.widgets[0].last).toEqual({ at: 5, error: 'Timed out after 20 s' });
  });

  test('a hosted runtime has no widget routes, so the list is absent rather than empty', async () => {
    expect(await respond(404, 'not json').api.list()).toBe('absent');
  });

  test('a refusal or a bad answer is an error, never an empty list', async () => {
    await refusedWith(respond(403, { error: 'Widgets can be seen and changed only on this Mac' }).api.list(), 'Widgets can be seen and changed only on this Mac', 403);
    await refusedWith(respond(200, { nothing: true }).api.list(), 'Could not load your widgets', 200);
  });

  test('turn on, turn off and refresh POST to the widget and answer the widget', async () => {
    for (const verb of ['enable', 'disable', 'refresh'] as const) {
      const { api, calls } = respond(200, { widget: { ...COMMAND_WIDGET, enabled: verb !== 'disable' } });
      const widget = await api[verb]('wid_0123456789abcdef');
      expect(calls).toEqual([{ path: `/api/mittr/widgets/wid_0123456789abcdef/${verb}`, method: 'POST' }]);
      expect(widget.enabled).toBe(verb !== 'disable');
    }
  });

  test('the server refusal text reaches the person', async () => {
    await refusedWith(
      respond(409, { error: 'The widgets tool is turned off in Settings → Integrations' }).api.enable('wid_0123456789abcdef'),
      'The widgets tool is turned off in Settings → Integrations',
      409,
    );
    await refusedWith(respond(500, 'not json').api.refresh('wid_0123456789abcdef'), 'Could not change the widget', 500);
  });

  test('remove sends DELETE and answers the removed id', async () => {
    const { api, calls } = respond(200, { removed: true, id: 'wid_0123456789abcdef' });
    expect(await api.remove('wid_0123456789abcdef')).toBe('wid_0123456789abcdef');
    expect(calls).toEqual([{ path: '/api/mittr/widgets/wid_0123456789abcdef', method: 'DELETE' }]);
  });
});

import type { JsonValue } from '@openchamber/sdk';
import { z } from 'zod';

import { runtimeFetch } from '../../../ui/src/lib/runtime-fetch';
import { errorTextOf, readJsonReply } from '../errorReply';
import { mittrT } from '../strings/mittrT';

const WIDGETS_ENDPOINT = '/api/mittr/widgets';

const widgetValue = z.union([
  z.number().transform((value) => ({ kind: 'number' as const, value })),
  z.string().transform((value) => ({ kind: 'text' as const, value })),
  z.array(z.string()).max(5).transform((value) => ({ kind: 'lines' as const, value })),
]);

const widgetPayload = z.object({
  id: z.string().min(1),
  title: z.string(),
  display: z.enum(['number', 'status', 'list']),
  source: z.discriminatedUnion('type', [
    z.object({ type: z.literal('url'), url: z.string() }),
    z.object({ type: z.literal('command'), command: z.string(), cwd: z.string() }),
  ]),
  refreshMinutes: z.number().int().min(5),
  alert: z.object({ op: z.enum(['above', 'below', 'equals']), value: z.union([z.number(), z.string()]) }).optional(),
  enabled: z.boolean(),
  last: z.union([
    z.object({ at: z.number(), error: z.string() }),
    z.object({ at: z.number(), value: widgetValue }),
  ]).optional(),
  alerting: z.boolean(),
});

const listPayload = z.object({
  widgets: z.array(widgetPayload.nullable().catch(null)),
  canChange: z.boolean(),
});

const onePayload = z.object({ widget: widgetPayload });

const removedPayload = z.object({ removed: z.literal(true), id: z.string() });

export type Widget = z.output<typeof widgetPayload>;

export type WidgetValue = z.output<typeof widgetValue>;

export type WidgetsList = { widgets: Widget[]; canChange: boolean };

type WidgetsResponse = { ok: boolean; status: number; json: () => Promise<JsonValue> };

export type WidgetsFetch = (path: string, init?: { method: string }) => Promise<WidgetsResponse>;

export type WidgetsApi = {
  list(): Promise<WidgetsList | 'absent'>;
  enable(id: string): Promise<Widget>;
  disable(id: string): Promise<Widget>;
  refresh(id: string): Promise<Widget>;
  remove(id: string): Promise<string>;
};

export class WidgetsRequestError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'WidgetsRequestError';
    this.status = status;
  }
}

const NOT_HERE = 404;

export function createWidgetsApi(fetchImpl: WidgetsFetch = runtimeFetch): WidgetsApi {
  const send = async (path: string, method: string, fallback: string): Promise<{ status: number; body: JsonValue | undefined; ok: boolean }> => {
    let response: WidgetsResponse;
    try {
      response = await fetchImpl(path, { method });
    } catch {
      throw new WidgetsRequestError(fallback, null);
    }
    return { status: response.status, ok: response.ok, body: await readJsonReply(response) };
  };

  const request = async <T>(path: string, method: string, schema: z.ZodType<T>, fallback: string): Promise<T> => {
    const reply = await send(path, method, fallback);
    if (!reply.ok) throw new WidgetsRequestError(errorTextOf(reply.body, fallback), reply.status);
    const parsed = schema.safeParse(reply.body);
    if (!parsed.success) throw new WidgetsRequestError(fallback, reply.status);
    return parsed.data;
  };

  const action = (id: string, verb: 'enable' | 'disable' | 'refresh'): Promise<Widget> =>
    request(`${WIDGETS_ENDPOINT}/${encodeURIComponent(id)}/${verb}`, 'POST', onePayload, mittrT('mittr.widgets.errors.actionFailed'))
      .then(({ widget }) => widget);

  return {
    list: async () => {
      const fallback = mittrT('mittr.widgets.errors.loadFailed');
      const reply = await send(WIDGETS_ENDPOINT, 'GET', fallback);
      if (reply.status === NOT_HERE) return 'absent';
      if (!reply.ok) throw new WidgetsRequestError(errorTextOf(reply.body, fallback), reply.status);
      const parsed = listPayload.safeParse(reply.body);
      if (!parsed.success) throw new WidgetsRequestError(fallback, reply.status);
      return { widgets: parsed.data.widgets.flatMap((widget) => (widget ? [widget] : [])), canChange: parsed.data.canChange };
    },
    enable: (id) => action(id, 'enable'),
    disable: (id) => action(id, 'disable'),
    refresh: (id) => action(id, 'refresh'),
    remove: async (id) => (await request(`${WIDGETS_ENDPOINT}/${encodeURIComponent(id)}`, 'DELETE', removedPayload, mittrT('mittr.widgets.errors.actionFailed'))).id,
  };
}

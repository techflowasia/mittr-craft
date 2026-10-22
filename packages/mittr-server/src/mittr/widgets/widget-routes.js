import { jsonBody } from '../json-body.js';
import { isLocalRequest } from '../tools/control-routes.js';
import { MittrToolError } from '../tools/registry.js';
import { widgetAccountOf } from './widget-actions.js';
import { WIDGETS_OFF } from './widget-runner.js';

export const WIDGETS_ROUTE = '/api/mittr/widgets';
export const ONLY_ON_THIS_MAC = 'Widgets can be seen and changed only on this Mac';

const BODY_LIMIT = 1024;

const noWidget = (id) => new MittrToolError(`There is no widget ${id}`, 404);

export function registerWidgetRoutes(app, { express, host, requestScope, store, runner, activeAccountKey, engineOnActiveHome, switchedOn, logger = console }) {
  const fromThisMac = (req, res, next) => (isLocalRequest(req, { host, requestScope }) ? next() : res.status(403).json({ error: ONLY_ON_THIS_MAC }));
  const readJson = jsonBody(express, { limit: BODY_LIMIT });
  const accountOf = () => widgetAccountOf({ activeAccountKey, engineOnActiveHome });

  const answer = (work) => async (req, res) => {
    try {
      return res.json(await work(req));
    } catch (error) {
      if (error instanceof MittrToolError) return res.status(error.statusCode).json({ error: error.message });
      logger.warn('[mittr] a widget route failed:', error?.name ?? 'Error');
      return res.status(500).json({ error: 'The widget could not be changed' });
    }
  };

  app.get(WIDGETS_ROUTE, fromThisMac, answer(async () => {
    const key = activeAccountKey();
    return { widgets: key ? store.list(key) : [], switchedOn: await switchedOn() };
  }));

  app.post(`${WIDGETS_ROUTE}/:id/enable`, fromThisMac, readJson, answer(async (req) => {
    const key = accountOf();
    if (!(await switchedOn())) throw new MittrToolError(WIDGETS_OFF, 409);
    const widget = store.turnOn(key, req.params.id, { revision: req.body?.revision });
    if (!widget) throw noWidget(req.params.id);
    void runner.tickQuietly();
    return { widget };
  }));

  app.post(`${WIDGETS_ROUTE}/:id/disable`, fromThisMac, answer((req) => {
    const key = accountOf();
    const widget = store.turnOff(key, req.params.id);
    if (!widget) throw noWidget(req.params.id);
    runner.stop(req.params.id);
    return { widget };
  }));

  app.post(`${WIDGETS_ROUTE}/:id/refresh`, fromThisMac, answer(async (req) => ({ widget: await runner.refresh(accountOf(), req.params.id) })));

  app.delete(`${WIDGETS_ROUTE}/:id`, fromThisMac, answer((req) => {
    const key = accountOf();
    if (!store.remove(key, req.params.id)) throw noWidget(req.params.id);
    runner.stop(req.params.id);
    return { removed: true, id: req.params.id };
  }));
}

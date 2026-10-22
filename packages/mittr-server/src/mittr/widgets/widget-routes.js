import { pinAccount } from '../tools/account-guard.js';
import { isLocalRequest } from '../tools/control-routes.js';
import { MittrToolError } from '../tools/registry.js';
import { NOT_SIGNED_IN } from './widget-actions.js';
import { WIDGETS_OFF } from './widget-runner.js';

export const WIDGETS_ROUTE = '/api/mittr/widgets';
export const ONLY_ON_THIS_MAC = 'Widgets can be seen and changed only on this Mac';

const noWidget = (id) => new MittrToolError(`There is no widget ${id}`, 404);

export function registerWidgetRoutes(app, { host, requestScope, store, runner, activeAccountKey, engineOnActiveHome, switchedOn, logger = console }) {
  const fromThisMac = (req, res, next) => (isLocalRequest(req, { host, requestScope }) ? next() : res.status(403).json({ error: ONLY_ON_THIS_MAC }));

  const accountOf = () => {
    const ensureSameAccount = pinAccount({ activeAccountKey, engineOnActiveHome });
    const key = activeAccountKey();
    if (!key) throw new MittrToolError(NOT_SIGNED_IN, 401);
    ensureSameAccount(key);
    return key;
  };

  const answer = (work) => async (req, res) => {
    try {
      return res.json(await work(req));
    } catch (error) {
      if (error instanceof MittrToolError) return res.status(error.statusCode).json({ error: error.message });
      logger.warn('[mittr] a widget route failed:', error?.name ?? 'Error');
      return res.status(500).json({ error: 'The widget could not be changed' });
    }
  };

  app.get(WIDGETS_ROUTE, fromThisMac, answer(() => {
    const key = activeAccountKey();
    return { widgets: key ? store.list(key) : [], canChange: true };
  }));

  app.post(`${WIDGETS_ROUTE}/:id/enable`, fromThisMac, answer(async (req) => {
    const key = accountOf();
    if (!(await switchedOn())) throw new MittrToolError(WIDGETS_OFF, 409);
    const widget = store.setEnabled(key, req.params.id, true);
    if (!widget) throw noWidget(req.params.id);
    void runner.tick();
    return { widget };
  }));

  app.post(`${WIDGETS_ROUTE}/:id/disable`, fromThisMac, answer((req) => {
    const key = accountOf();
    const widget = store.setEnabled(key, req.params.id, false);
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

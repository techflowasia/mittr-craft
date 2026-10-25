import { jsonBody } from '../json-body.js';
import { isLocalRequest } from '../tools/control-routes.js';
import { MittrToolError } from '../tools/registry.js';
import { widgetAccountOf } from './widget-actions.js';
import { WIDGETS_OFF } from './widget-runner.js';
import { CHANGED_SINCE_SEEN, SAY_WHAT_YOU_SAW } from './widget-store.js';

export const WIDGETS_ROUTE = '/api/mittr/widgets';
export const ONLY_ON_THIS_MAC = 'Widgets can be seen and changed only on this Mac';

const BODY_LIMIT = 1024;

export const NEEDS_THE_PERSON = 'Turning a widget on needs the person at this Mac to agree in the dialog';
export const NOT_TURNED_ON = 'The widget was not turned on';
const ACCOUNT_CHANGED = 'The account changed while the dialog was open; the widget was not turned on';

const noWidget = (id) => new MittrToolError(`There is no widget ${id}`, 404);

const whatItDoes = ({ source, refreshMinutes }) => (source.type === 'url'
  ? `Every ${refreshMinutes} minutes it reads ${source.url}`
  : `Every ${refreshMinutes} minutes it runs this command in ${source.cwd}:\n\n${source.command}`);

export const turnOnQuestion = (widget) => ({
  title: 'Turn on a widget',
  message: `Turn on "${widget.title}"?`,
  detail: `${whatItDoes(widget)}\n\nTurn it on only if you asked for this widget.`,
  confirmLabel: 'Turn on',
  cancelLabel: 'Cancel',
});

const personAgrees = async (host, widget) => {
  if (typeof host?.confirm !== 'function') throw new MittrToolError(NEEDS_THE_PERSON, 403);
  let answer = false;
  try {
    answer = await host.confirm(turnOnQuestion(widget));
  } catch {
    answer = false;
  }
  if (answer !== true) throw new MittrToolError(NOT_TURNED_ON, 403);
};

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
    const revision = req.body?.revision;
    const seen = store.get(key, req.params.id);
    if (!seen) throw noWidget(req.params.id);
    if (typeof revision !== 'string' || !revision) throw new MittrToolError(SAY_WHAT_YOU_SAW, 400);
    if (revision !== seen.revision) throw new MittrToolError(CHANGED_SINCE_SEEN, 409);
    await personAgrees(host, seen);
    if (accountOf() !== key) throw new MittrToolError(ACCOUNT_CHANGED, 409);
    const widget = store.turnOn(key, req.params.id, { revision });
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

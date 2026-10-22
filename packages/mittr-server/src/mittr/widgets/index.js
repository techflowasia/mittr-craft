import { enginePortOf } from '../tools/index.js';
import { registerWidgetActions } from './widget-actions.js';
import { registerWidgetRoutes } from './widget-routes.js';
import { TICK_MS, createWidgetRunner } from './widget-runner.js';
import { createUrlSource, runCommand } from './widget-sources.js';
import { createWidgetStore } from './widget-store.js';

const NOTIFY_ROUTE = '/api/notifications/emit';
const TITLE_MAX = 120;
const BODY_MAX = 500;

const shownValue = (value) => (Array.isArray(value) ? value.join(', ') : String(value));

export const notifyThroughServer = ({ port, fetchImpl = (...args) => fetch(...args) }) => async (widget) => {
  const bound = port();
  if (!Number.isInteger(bound)) return false;
  const line = widget.alert ? `Now ${shownValue(widget.last?.value)}, ${widget.alert.op} ${widget.alert.value}` : `Now ${shownValue(widget.last?.value)}`;
  const response = await fetchImpl(`http://127.0.0.1:${bound}${NOTIFY_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: widget.title.slice(0, TITLE_MAX), body: line.slice(0, BODY_MAX), tag: `mittr-widget-${widget.id}` }),
  });
  return response.ok;
};

const NOTHING = Object.freeze({ runner: null, accountChanged: () => {}, dispose: () => {} });

export function setupMittrWidgets(context, {
  registry,
  mittrSettings,
  tools,
  activeAccountKey,
  engineOnActiveHome,
  personalDesktop,
  env = process.env,
  sources = null,
  notify = null,
  tickMs = TICK_MS,
  logger = console,
}) {
  const { app, host, requestScope, dataDir, server, opencode } = context;
  if (!host || !personalDesktop()) return NOTHING;

  const store = createWidgetStore({ dataDir, logger });
  const switchedOn = async () => (await mittrSettings.read()).tools.widgets !== false;
  const runner = createWidgetRunner({
    store,
    sources: sources ?? {
      url: createUrlSource({ ownPorts: () => [server.port(), enginePortOf(opencode)].filter(Number.isInteger) }),
      command: (source, { signal }) => runCommand(source, { env, signal }),
    },
    activeAccountKey,
    engineOnActiveHome,
    switchedOn,
    notify: notify ?? notifyThroughServer({ port: () => server.port() }),
    logger,
  });

  registerWidgetActions(registry, {
    store,
    activeAccountKey,
    engineOnActiveHome,
    changed: (id, widget) => {
      if (widget?.enabled !== true) runner.stop(id);
    },
  });
  registerWidgetRoutes(app, { host, requestScope, store, runner, activeAccountKey, engineOnActiveHome, switchedOn, logger });

  const unsubscribe = tools.onSwitchChange((switches) => runner.switchChanged(switches));
  runner.start(tickMs);

  return {
    store,
    runner,
    accountChanged: () => runner.accountChanged(),
    dispose: () => {
      unsubscribe();
      runner.dispose();
    },
  };
}

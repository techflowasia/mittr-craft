import { pinAccount } from '../tools/account-guard.js';
import { MITTR_TOOLS, MittrToolError } from '../tools/registry.js';
import { trimmedText } from '../values.js';
import { MIN_REFRESH_MINUTES } from './widget-store.js';

export const WIDGET_ACTIONS = Object.freeze(['widget.create', 'widget.update', 'widget.remove', 'widget.list']);
export const WIDGET_SURFACES = Object.freeze(['agent', 'http']);
export const NOT_SIGNED_IN = 'Sign in to Mittr to keep widgets; they are kept per Mittr account';

export const WIDGETS_TOOL_DESCRIPTION = [
  'Make small cards on the person\'s Today page that keep an eye on something: a number, a status (ok, warn or fail) or a short list, refreshed on a schedule.',
  'A source is a URL fetched from this Mac with no cookies (public addresses only), or a shell command run in a project folder with a clean environment.',
  'An extract rule picks the value: extract.json is a JSON path such as build.status, extract.regex is a pattern whose first group is the value, and extract.status maps words to ok, warn or fail.',
  'A new widget starts switched off and runs nothing: only the person can turn it on, from Today. Changing its source turns it off again.',
  `Refresh at most every ${MIN_REFRESH_MINUTES} minutes. An alert (above, below or equals) marks the card and notifies the person once each time the value crosses the line.`,
].join(' ');

const EXTRACT_SCHEMA = Object.freeze({
  type: 'object',
  description: 'How to pick the value: json (a JSON path), or regex with an optional group, plus an optional status map',
  properties: {
    json: { type: 'string', description: 'JSON path, e.g. build.status or items[0].price' },
    regex: { type: 'string', description: 'Pattern; the first group is the value' },
    group: { type: 'integer', description: 'Which group of regex is the value (default 1)' },
    status: { type: 'object', description: 'Words for each status, e.g. { "ok": ["SUCCESS"], "fail": ["FAILURE"] }' },
  },
});

const WIDGETS_TOOL_PARAMETERS = Object.freeze({
  id: { type: 'string', description: 'The widget id, for widget.update and widget.remove' },
  title: { type: 'string', description: 'Short card title' },
  display: { type: 'string', enum: ['number', 'status', 'list'], description: 'How the card shows its value' },
  source: {
    type: 'object',
    description: '{ type: "url", url, extract } or { type: "command", command, cwd, extract }; cwd defaults to this session\'s project folder',
    properties: {
      type: { type: 'string', enum: ['url', 'command'] },
      url: { type: 'string' },
      command: { type: 'string' },
      cwd: { type: 'string' },
      extract: EXTRACT_SCHEMA,
    },
  },
  refreshMinutes: { type: 'integer', description: `Minutes between refreshes, at least ${MIN_REFRESH_MINUTES} (default 15)` },
  alert: { type: 'object', description: '{ op: "above" | "below" | "equals", value }; above and below take a number' },
});

const DEFINITIONS = Object.freeze([
  { action: 'widget.create', title: 'Make a widget', description: 'Make a widget on Today; it starts switched off until the person turns it on', effect: 'change' },
  { action: 'widget.update', title: 'Change a widget', description: 'Change a widget\'s title, display, source, refresh or alert; a new source switches it off', effect: 'change' },
  { action: 'widget.remove', title: 'Remove a widget', description: 'Remove a widget from Today', effect: 'change' },
  { action: 'widget.list', title: 'List the widgets', description: 'List the widgets on Today with their last values', effect: 'read' },
]);

const idOf = (input) => {
  const id = trimmedText(input.id);
  if (!id) throw new MittrToolError('id is required', 400);
  return id;
};

const fieldsOf = (input) => Object.fromEntries(Object.entries(input).filter(([name]) => name !== 'id'));

export function registerWidgetActions(registry, { store, activeAccountKey, engineOnActiveHome, changed = () => {} }) {
  registry.defineTool({ name: MITTR_TOOLS.widgets, description: WIDGETS_TOOL_DESCRIPTION, parameters: WIDGETS_TOOL_PARAMETERS });

  const accountOf = () => {
    const ensureSameAccount = pinAccount({ activeAccountKey, engineOnActiveHome });
    const key = activeAccountKey();
    if (!key) throw new MittrToolError(NOT_SIGNED_IN, 401);
    ensureSameAccount(key);
    return key;
  };

  const runs = {
    'widget.create': (input, ctx) => {
      const widget = store.create(accountOf(), input, { directory: ctx.directory });
      changed(widget.id, widget);
      return { widget, note: 'The widget is on Today, switched off. Ask the person to turn it on there.' };
    },
    'widget.update': (input, ctx) => {
      const id = idOf(input);
      const widget = store.update(accountOf(), id, fieldsOf(input), { directory: ctx.directory });
      changed(id, widget);
      return widget.enabled ? { widget } : { widget, note: 'The widget is switched off. Only the person can turn it on, from Today.' };
    },
    'widget.remove': (input) => {
      const id = idOf(input);
      if (!store.remove(accountOf(), id)) throw new MittrToolError(`There is no widget ${id}`, 404);
      changed(id, null);
      return { removed: true, id };
    },
    'widget.list': () => ({ widgets: store.list(accountOf()) }),
  };

  for (const definition of DEFINITIONS) {
    registry.register({
      ...definition,
      tool: MITTR_TOOLS.widgets,
      surfaces: WIDGET_SURFACES,
      execute: async (input, ctx) => runs[definition.action](input ?? {}, ctx ?? {}),
    });
  }
}

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { writePrivateAtomic } from '../private-file.js';
import { MittrToolError } from '../tools/registry.js';
import { isPlainObject, isText, trimmedText } from '../values.js';
import { filesUnchanged, fingerprintsOf, isDirectory, sourceFiles } from './widget-files.js';
import { jsonPathParts } from './widget-sources.js';

export const MIN_REFRESH_MINUTES = 5;
export const MAX_REFRESH_MINUTES = 24 * 60;
export const DEFAULT_REFRESH_MINUTES = 15;
export const MAX_WIDGETS = 20;
export const ONLY_THE_PERSON_TURNS_ON = 'Only the person can turn a widget on, from Today';
export const CHANGED_SINCE_SEEN = 'This widget changed since you looked; check it again';
export const SAY_WHAT_YOU_SAW = 'Turning a widget on needs the revision of the widget you saw';
export const OFF_BECAUSE = Object.freeze({ changed: 'changed', files: 'files' });

const DIR = 'widgets';
const ACCOUNT_KEY = /^[0-9a-f]{16}$/;
const DISPLAYS = Object.freeze(['number', 'status', 'list']);
const ALERT_OPS = Object.freeze(['above', 'below', 'equals']);
const STATUSES = Object.freeze(['ok', 'warn', 'fail']);
const TITLE_MAX = 80;
const URL_MAX = 2_048;
const COMMAND_MAX = 2_000;
const PATTERN_MAX = 500;
const PATH_MAX = 200;
const WORDS_MAX = 20;
const UPDATABLE = new Set(['title', 'display', 'source', 'refreshMinutes', 'alert']);

const refused = (message) => new MittrToolError(message, 400);

const titleOf = (value) => {
  const title = trimmedText(value);
  if (!title || title.length > TITLE_MAX) throw refused(`title is required, at most ${TITLE_MAX} characters`);
  return title;
};

const displayOf = (value) => {
  if (!DISPLAYS.includes(value)) throw refused('display must be number, status or list');
  return value;
};

const statusWordsOf = (value) => {
  if (value === undefined) return undefined;
  if (!isPlainObject(value) || !Object.keys(value).every((key) => STATUSES.includes(key))) throw refused('extract.status maps ok, warn and fail to lists of words');
  return Object.fromEntries(Object.entries(value).map(([status, words]) => {
    if (!Array.isArray(words) || words.length > WORDS_MAX || !words.every((word) => trimmedText(word) && word.length <= TITLE_MAX)) {
      throw refused('extract.status maps ok, warn and fail to lists of words');
    }
    return [status, words.map((word) => word.trim())];
  }));
};

const extractOf = (value) => {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw refused('extract must be an object');
  const extract = {};
  if (value.json !== undefined && value.regex !== undefined) throw refused('extract takes a JSON path or a pattern, not both');
  if (value.json !== undefined) {
    if (!trimmedText(value.json) || value.json.length > PATH_MAX || jsonPathParts(value.json) === null) throw refused('extract.json must be a JSON path such as build.status or items[0].price');
    extract.json = value.json.trim();
  }
  if (value.regex !== undefined) {
    if (!isText(value.regex) || !value.regex || value.regex.length > PATTERN_MAX) throw refused(`extract.regex must be a pattern of at most ${PATTERN_MAX} characters`);
    try {
      new RegExp(value.regex);
    } catch {
      throw refused('extract.regex is not a pattern that can run');
    }
    extract.regex = value.regex;
    if (value.group !== undefined) {
      if (!Number.isInteger(value.group) || value.group < 0 || value.group > 9) throw refused('extract.group must be a whole number from 0 to 9');
      extract.group = value.group;
    }
  }
  const status = statusWordsOf(value.status);
  if (status) extract.status = status;
  return extract;
};

const urlOf = (value) => {
  const text = trimmedText(value);
  let page = null;
  try {
    page = text && text.length <= URL_MAX ? new URL(text) : null;
  } catch {
    page = null;
  }
  if (!page || (page.protocol !== 'http:' && page.protocol !== 'https:')) throw refused('source.url must be a full http(s) address');
  if (page.username || page.password) throw refused('source.url cannot carry a sign-in');
  return page.toString();
};

const sourceOf = (value, { directory } = {}) => {
  if (!isPlainObject(value)) throw refused('source must be { type: "url", url } or { type: "command", command, cwd }');
  if (value.type === 'url') return { type: 'url', url: urlOf(value.url), extract: extractOf(value.extract) };
  if (value.type === 'command') {
    const command = isText(value.command) ? value.command.trim() : '';
    if (!command || command.length > COMMAND_MAX || command.includes('\0')) throw refused(`source.command is required, at most ${COMMAND_MAX} characters`);
    const cwd = trimmedText(value.cwd) ?? trimmedText(directory);
    if (!cwd || !path.isAbsolute(cwd) || !isDirectory(cwd)) throw refused('source.cwd must be the full path of a project folder on this Mac');
    return { type: 'command', command, cwd: path.resolve(cwd), extract: extractOf(value.extract) };
  }
  throw refused('source must be { type: "url", url } or { type: "command", command, cwd }');
};

const refreshOf = (value) => {
  if (value === undefined) return DEFAULT_REFRESH_MINUTES;
  if (!Number.isInteger(value) || value < MIN_REFRESH_MINUTES || value > MAX_REFRESH_MINUTES) {
    throw refused(`refreshMinutes must be a whole number of at least ${MIN_REFRESH_MINUTES} and at most ${MAX_REFRESH_MINUTES}`);
  }
  return value;
};

const alertOf = (value, display) => {
  if (value === undefined || value === null) return null;
  const wrong = () => refused('alert must be { op: "above" | "below" | "equals", value }, above and below with a number, and no alert on a list');
  if (!isPlainObject(value) || !ALERT_OPS.includes(value.op) || display === 'list') throw wrong();
  if (value.op !== 'equals') {
    if (display !== 'number' || !Number.isFinite(value.value)) throw wrong();
    return { op: value.op, value: value.value };
  }
  if (Number.isFinite(value.value)) return { op: 'equals', value: value.value };
  const text = trimmedText(value.value);
  if (!text || text.length > TITLE_MAX) throw wrong();
  return { op: 'equals', value: text };
};

export const sourceSignature = (source) => JSON.stringify(source);

export const sourceRevision = (source) => createHash('sha256').update(sourceSignature(source)).digest('hex');

const isApproved = (widget) => widget.enabled === true && isText(widget.approvedRevision) && widget.approvedRevision === sourceRevision(widget.source);

const switchedOff = (widget, offReason) => {
  const { approvedRevision: _revision, approvedFiles: _files, offReason: _reason, ...rest } = widget;
  return offReason ? { ...rest, enabled: false, alerting: false, offReason } : { ...rest, enabled: false, alerting: false };
};

export const widgetView = (widget) => {
  const view = {
    id: widget.id,
    title: widget.title,
    display: widget.display,
    source: structuredClone(widget.source),
    revision: sourceRevision(widget.source),
    files: sourceFiles(widget.source),
    refreshMinutes: widget.refreshMinutes,
  };
  if (widget.alert) view.alert = { ...widget.alert };
  view.enabled = isApproved(widget);
  if (!view.enabled && Object.values(OFF_BECAUSE).includes(widget.offReason)) view.offReason = widget.offReason;
  if (widget.last) view.last = { ...widget.last };
  view.alerting = view.enabled && widget.alerting === true;
  return view;
};

const newWidgetId = () => `wid_${randomBytes(8).toString('hex')}`;

export function createWidgetStore({ dataDir, now = Date.now, newId = newWidgetId, logger = console }) {
  const dir = path.join(dataDir, DIR);
  const warned = new Set();

  const fileOf = (key) => {
    if (!isText(key) || !ACCOUNT_KEY.test(key)) throw new Error('A widget account key is a Mittr account key');
    return path.join(dir, `${key}.json`);
  };

  const read = (key) => {
    const file = fileOf(key);
    let stored;
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT' && !warned.has(key)) {
        warned.add(key);
        logger.warn('[mittr] a widgets file cannot be read; it reads as no widgets:', error?.name ?? 'Error');
      }
      return [];
    }
    return Array.isArray(stored?.widgets) ? stored.widgets.filter((widget) => isPlainObject(widget) && isText(widget.id)) : [];
  };

  const write = (key, widgets) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writePrivateAtomic(fileOf(key), `${JSON.stringify({ version: 1, widgets }, null, 2)}\n`);
  };

  const change = (key, id, edit) => {
    const widgets = read(key);
    const at = widgets.findIndex((widget) => widget.id === id);
    if (at === -1) return null;
    const result = edit(widgets[at]);
    if (!result) return null;
    widgets[at] = result.widget;
    write(key, widgets);
    return result;
  };

  return {
    list: (key) => read(key).map(widgetView),

    get: (key, id) => {
      const widget = read(key).find((entry) => entry.id === id);
      return widget ? widgetView(widget) : null;
    },

    create: (key, input, { directory } = {}) => {
      if (!isPlainObject(input)) throw refused('Give the widget as an object');
      if (Object.hasOwn(input, 'enabled')) throw new MittrToolError(ONLY_THE_PERSON_TURNS_ON, 403);
      const widgets = read(key);
      if (widgets.length >= MAX_WIDGETS) throw new MittrToolError(`There are already ${MAX_WIDGETS} widgets; remove one first`, 409);
      const display = displayOf(input.display);
      const at = now();
      const widget = {
        id: newId(),
        title: titleOf(input.title),
        display,
        source: sourceOf(input.source, { directory }),
        refreshMinutes: refreshOf(input.refreshMinutes),
        alert: alertOf(input.alert, display),
        enabled: false,
        alerting: false,
        last: null,
        createdAt: at,
        updatedAt: at,
      };
      write(key, [...widgets, widget]);
      return widgetView(widget);
    },

    update: (key, id, patch, { directory } = {}) => {
      if (!isPlainObject(patch)) throw refused('Give the changes as an object');
      if (Object.hasOwn(patch, 'enabled')) throw new MittrToolError(ONLY_THE_PERSON_TURNS_ON, 403);
      const unknown = Object.keys(patch).find((name) => !UPDATABLE.has(name));
      if (unknown) throw refused(`${unknown} cannot be changed; change title, display, source, refreshMinutes or alert`);
      const result = change(key, id, (widget) => {
        const display = Object.hasOwn(patch, 'display') ? displayOf(patch.display) : widget.display;
        const source = Object.hasOwn(patch, 'source') ? sourceOf(patch.source, { directory: widget.source.cwd ?? directory }) : widget.source;
        const alert = Object.hasOwn(patch, 'alert') ? alertOf(patch.alert, display) : alertOf(widget.alert ?? undefined, display);
        const refreshMinutes = Object.hasOwn(patch, 'refreshMinutes') ? refreshOf(patch.refreshMinutes) : widget.refreshMinutes;
        const sourceChanged = sourceSignature(source) !== sourceSignature(widget.source);
        const meaningChanged = sourceChanged || display !== widget.display;
        const turnsOff = sourceChanged || refreshMinutes < widget.refreshMinutes;
        const next = {
          ...widget,
          title: Object.hasOwn(patch, 'title') ? titleOf(patch.title) : widget.title,
          display,
          source,
          refreshMinutes,
          alert,
          alerting: meaningChanged || JSON.stringify(alert) !== JSON.stringify(widget.alert ?? null) ? false : widget.alerting === true,
          last: meaningChanged ? null : widget.last ?? null,
          updatedAt: now(),
        };
        if (!turnsOff) return { widget: next };
        return { widget: switchedOff(next, isApproved(widget) || widget.offReason ? OFF_BECAUSE.changed : null) };
      });
      if (!result) throw new MittrToolError(`There is no widget ${id}`, 404);
      return widgetView(result.widget);
    },

    remove: (key, id) => {
      const widgets = read(key);
      const kept = widgets.filter((widget) => widget.id !== id);
      if (kept.length === widgets.length) return false;
      write(key, kept);
      return true;
    },

    turnOn: (key, id, { revision } = {}) => {
      if (!isText(revision) || !revision) throw refused(SAY_WHAT_YOU_SAW);
      const result = change(key, id, (widget) => {
        const current = sourceRevision(widget.source);
        if (revision !== current) throw new MittrToolError(CHANGED_SINCE_SEEN, 409);
        const { offReason: _reason, ...rest } = widget;
        return {
          widget: {
            ...rest,
            enabled: true,
            approvedRevision: current,
            approvedFiles: fingerprintsOf(sourceFiles(widget.source)),
            alerting: isApproved(widget) ? widget.alerting === true : false,
            updatedAt: now(),
          },
        };
      });
      return result ? widgetView(result.widget) : null;
    },

    turnOff: (key, id) => {
      const result = change(key, id, (widget) => ({ widget: { ...switchedOff(widget, null), updatedAt: now() } }));
      return result ? widgetView(result.widget) : null;
    },

    stopChangedFiles: (key) => {
      const widgets = read(key);
      const stopped = [];
      const next = widgets.map((widget) => {
        if (!isApproved(widget) || filesUnchanged(widget.approvedFiles, sourceFiles(widget.source))) return widget;
        stopped.push(widget.id);
        return { ...switchedOff(widget, OFF_BECAUSE.files), updatedAt: now() };
      });
      if (stopped.length > 0) write(key, next);
      return stopped;
    },

    record: (key, id, { signature, last, alerting }) => {
      const result = change(key, id, (widget) => {
        if (!isApproved(widget) || sourceSignature(widget.source) !== signature) return null;
        const next = alerting === true;
        return { widget: { ...widget, last, alerting: next }, rose: next && widget.alerting !== true };
      });
      return result ? { widget: widgetView(result.widget), rose: result.rose } : null;
    },
  };
}

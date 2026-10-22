import { jsonBody } from './json-body.js';
import { SUGGESTION_STYLES } from './mittr-settings.js';
import { isLocalRequest } from './tools/control-routes.js';
import { isPlainObject } from './values.js';

const ROUTE = '/api/mittr/chat/settings';
const BODY_LIMIT = '8kb';

const INVALID = 'suggestionStyle must be next-step or unfinished-only';
const CANNOT_STORE = 'Cannot store the suggestion setting on this machine';
const NOT_APPLIED = 'The suggestion setting is saved, but it could not be applied yet';
const CANNOT_READ = 'Could not read the suggestion setting';
const ONLY_ON_THIS_MAC = 'These settings can be changed only on this Mac';

const isValidBody = (body) => isPlainObject(body)
  && Object.keys(body).length === 1
  && SUGGESTION_STYLES.includes(body.suggestionStyle);

const viewOf = (settings, canChange) => ({ suggestionStyle: settings.suggestionStyle, canChange });

export function registerChatSettingsRoutes(app, { express, host, requestScope, mittrSettings, suggestionStyle, logger = console }) {
  const readJson = jsonBody(express, { limit: BODY_LIMIT });
  const local = (req) => isLocalRequest(req, { host, requestScope });

  const fromThisMac = (req, res, next) => (local(req) ? next() : res.status(403).json({ error: ONLY_ON_THIS_MAC }));

  app.get(ROUTE, async (req, res) => {
    let settings;
    try {
      settings = await mittrSettings.read();
    } catch (error) {
      logger.warn('[mittr] could not read the suggestion setting:', error?.message ?? error);
      return res.status(500).json({ error: CANNOT_READ });
    }
    return res.json(viewOf(settings, local(req)));
  });

  app.put(ROUTE, fromThisMac, readJson, async (req, res) => {
    if (!isValidBody(req.body)) return res.status(400).json({ error: INVALID });
    let stored;
    try {
      stored = await mittrSettings.update({ suggestionStyle: req.body.suggestionStyle });
    } catch (error) {
      logger.warn('[mittr] the suggestion setting could not be stored:', error?.message ?? error);
      return res.status(500).json({ error: CANNOT_STORE });
    }
    if (!suggestionStyle.apply(stored.suggestionStyle)) return res.status(500).json({ error: NOT_APPLIED, ...viewOf(stored, true) });
    return res.json(viewOf(stored, true));
  });
}

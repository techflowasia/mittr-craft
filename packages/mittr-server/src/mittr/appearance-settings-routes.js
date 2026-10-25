import { jsonBody } from './json-body.js';
import { SIDEBAR_SIDES } from './mittr-settings.js';
import { isLocalRequest } from './tools/control-routes.js';
import { isPlainObject } from './values.js';

const ROUTE = '/api/mittr/appearance/settings';
const BODY_LIMIT = '8kb';

const INVALID = 'sidebarSide must be left or right';
const CANNOT_STORE = 'Cannot store the sidebar setting on this machine';
const CANNOT_READ = 'Could not read the sidebar setting';
const ONLY_ON_THIS_MAC = 'These settings can be changed only on this Mac';

const isValidBody = (body) => isPlainObject(body)
  && Object.keys(body).length === 1
  && SIDEBAR_SIDES.includes(body.sidebarSide);

const viewOf = (settings, canChange) => ({ sidebarSide: settings.sidebarSide, canChange });

export function registerAppearanceSettingsRoutes(app, { express, host, requestScope, mittrSettings, logger = console }) {
  const readJson = jsonBody(express, { limit: BODY_LIMIT });
  const local = (req) => isLocalRequest(req, { host, requestScope });

  const fromThisMac = (req, res, next) => (local(req) ? next() : res.status(403).json({ error: ONLY_ON_THIS_MAC }));

  app.get(ROUTE, async (req, res) => {
    let settings;
    try {
      settings = await mittrSettings.read();
    } catch (error) {
      logger.warn('[mittr] could not read the sidebar setting:', error?.message ?? error);
      return res.status(500).json({ error: CANNOT_READ });
    }
    return res.json(viewOf(settings, local(req)));
  });

  app.put(ROUTE, fromThisMac, readJson, async (req, res) => {
    if (!isValidBody(req.body)) return res.status(400).json({ error: INVALID });
    let stored;
    try {
      stored = await mittrSettings.update({ sidebarSide: req.body.sidebarSide });
    } catch (error) {
      logger.warn('[mittr] the sidebar setting could not be stored:', error?.message ?? error);
      return res.status(500).json({ error: CANNOT_STORE });
    }
    return res.json(viewOf(stored, true));
  });
}

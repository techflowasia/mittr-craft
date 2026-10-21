import { jsonBody } from '../json-body.js';
import { isHost, profileOf } from '../mittr-settings.js';
import { isPlainObject } from '../values.js';

const ROUTE = '/api/mittr/tools';
const PROFILES_ROUTE = `${ROUTE}/chrome/profiles`;
const HOST_ROUTE = `${ROUTE}/chrome/approved-hosts/:host`;
const BODY_LIMIT = '8kb';

const NOTHING_GIVEN = 'Give at least one tool setting';
const CANNOT_STORE = 'Cannot store the tool setting on this machine';
const NOT_APPLIED = 'The tool setting is saved, but agents have not been given it yet';
const CHROME_NOT_OFFERED = 'The Chrome tool is not available in this install';
const CANNOT_LIST = 'Could not list the Chrome profiles on this Mac';
const CANNOT_REMOVE = 'Could not remove the site';
const NOT_A_SITE = 'That is not a site name';

const isBoolean = (value) => value === true || value === false;

const SETTINGS = Object.freeze({
  computer: isBoolean,
  chrome: isBoolean,
  chromeHeaded: isBoolean,
  chromeProfile: (value) => profileOf(value) === value,
});

const invalid = (key) => `Unknown or invalid tool setting: ${key}`;

const listedProfiles = (listed) => (Array.isArray(listed) ? listed : []).flatMap((entry) => {
  const directory = profileOf(entry?.directory);
  if (!directory || directory !== entry.directory) return [];
  const name = entry.name === String(entry.name) && entry.name.trim() ? entry.name.trim() : directory;
  return [{ directory, name }];
});

const refusalOf = (body) => {
  if (!isPlainObject(body) || Object.keys(body).length === 0) return NOTHING_GIVEN;
  const wrong = Object.entries(body).find(([key, value]) => !Object.hasOwn(SETTINGS, key) || !SETTINGS[key](value));
  return wrong ? invalid(wrong[0]) : null;
};

const storedAll = (patch, view) => {
  const stored = {
    computer: view.computer.enabled,
    chrome: view.chrome.enabled,
    chromeHeaded: view.chrome.headed,
    chromeProfile: view.chrome.profile,
  };
  return Object.entries(patch).every(([key, value]) => stored[key] === value);
};

export function registerMittrToolsSettingsRoutes(app, { express, view, apply, profiles, removeHost, logger = console }) {
  const readJson = jsonBody(express, { limit: BODY_LIMIT });

  const chromeProfiles = async () => listedProfiles(await profiles());

  app.get(ROUTE, async (_req, res) => {
    res.json(await view());
  });

  app.put(ROUTE, readJson, async (req, res) => {
    const refusal = refusalOf(req.body);
    if (refusal) return res.status(400).json({ error: refusal });
    const patch = req.body;
    if (Object.hasOwn(patch, 'chromeProfile')) {
      const listed = (await view()).chrome.offered ? await chromeProfiles().catch(() => []) : [];
      if (!listed.some(({ directory }) => directory === patch.chromeProfile)) return res.status(400).json({ error: invalid('chromeProfile') });
    }
    try {
      await apply(patch);
    } catch (error) {
      const current = await view();
      const saved = storedAll(patch, current);
      logger.warn(`[mittr] a tool setting change ${saved ? 'was saved but not given to agents' : 'could not be saved'}:`, error?.message ?? error);
      return res.status(500).json({ error: saved ? NOT_APPLIED : CANNOT_STORE, ...current });
    }
    return res.json(await view());
  });

  app.get(PROFILES_ROUTE, async (_req, res) => {
    if (!(await view()).chrome.offered) return res.status(503).json({ error: CHROME_NOT_OFFERED });
    try {
      return res.json({ profiles: await chromeProfiles() });
    } catch (error) {
      logger.warn('[mittr] could not list the Chrome profiles:', error?.message ?? error);
      return res.status(502).json({ error: CANNOT_LIST });
    }
  });

  app.delete(HOST_ROUTE, async (req, res) => {
    const host = String(req.params.host ?? '').trim().toLowerCase();
    if (!isHost(host)) return res.status(400).json({ error: NOT_A_SITE });
    if (!(await view()).chrome.offered) return res.status(503).json({ error: CHROME_NOT_OFFERED });
    try {
      return res.json({ hosts: await removeHost(host) });
    } catch (error) {
      logger.warn('[mittr] could not remove an allowed Chrome site:', error?.message ?? error);
      return res.status(500).json({ error: CANNOT_REMOVE });
    }
  });
}

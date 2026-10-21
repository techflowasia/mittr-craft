import { jsonBody } from './json-body.js';

export const PROVIDER_LOCK_CHANGED_EVENT = 'mittr.provider-lock.changed';

const ROUTE = '/api/mittr/provider-lock';
const BODY_LIMIT = '1kb';

const INVALID_VALUE = 'showOtherProviders must be true or false';
const CANNOT_STORE = 'Cannot store the setting on this machine';
const NOT_APPLIED = 'The setting is saved, but the engine has not taken it up yet';

/**
 * The switch that lets the person use providers other than Mittr (R37/R40),
 * under `/api`, so it carries the UI's own auth.
 *
 * `GET` answers `{ showOtherProviders }`. `PUT { showOtherProviders }` stores
 * it in `mittr-settings.json`, has the managed engine config rewritten with
 * the matching lock (the engine reloads it without a restart) and announces
 * `mittr.provider-lock.changed` on the UI event stream.
 *
 * A switch that cannot be stored changes nothing. One that is stored but not
 * yet in the engine config answers 500 with the stored value: the stored
 * value is what the next config write or engine start uses, and the same PUT
 * again writes it now.
 */
export function registerProviderLockRoutes(app, { express, mittrSettings, managedConfig, events, logger = console }) {
  const readJson = jsonBody(express, { limit: BODY_LIMIT });

  app.get(ROUTE, async (_req, res) => {
    res.json(await mittrSettings.read());
  });

  app.put(ROUTE, readJson, async (req, res) => {
    const showOtherProviders = Array.isArray(req.body) ? undefined : req.body?.showOtherProviders;
    if (showOtherProviders !== true && showOtherProviders !== false) {
      return res.status(400).json({ error: INVALID_VALUE });
    }

    let stored;
    try {
      stored = await mittrSettings.update({ showOtherProviders });
    } catch (error) {
      logger.warn('[mittr] could not store the provider switch:', error?.message ?? error);
      return res.status(500).json({ error: CANNOT_STORE });
    }

    let applied = true;
    try {
      await managedConfig.refresh();
    } catch (error) {
      applied = false;
      logger.warn('[mittr] the provider switch is saved but the engine config was not rewritten:', error?.message ?? error);
    }
    events.broadcast(PROVIDER_LOCK_CHANGED_EVENT, stored);
    return applied ? res.json(stored) : res.status(500).json({ error: NOT_APPLIED, ...stored });
  });
}

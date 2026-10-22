import { jsonBody } from '../json-body.js';
import { isPlainObject } from '../values.js';
import { isLocalRequest } from '../tools/control-routes.js';

const ROUTE = '/api/mittr/voice/settings';
const BODY_LIMIT = '8kb';

const NOTHING_GIVEN = 'Give at least one voice setting';
const CANNOT_STORE = 'Cannot store the voice setting on this machine';
const CANNOT_READ = 'Could not read the voice settings';
const ONLY_ON_THIS_MAC = 'These settings can be changed only on this Mac';

const withinRange = (min, max) => (value) => Number.isInteger(value) && value >= min && value <= max;

const LIMITS = Object.freeze({
  stepCap: withinRange(1, 20),
  replyMaxChars: withinRange(1000, 30000),
});

const invalid = (key) => `Unknown or invalid voice setting: ${key}`;

const refusalOf = (body) => {
  if (!isPlainObject(body) || Object.keys(body).length === 0) return NOTHING_GIVEN;
  const wrong = Object.entries(body).find(([key, value]) => !Object.hasOwn(LIMITS, key) || !LIMITS[key](value));
  return wrong ? invalid(wrong[0]) : null;
};

const viewOf = (settings, canChange) => ({
  stepCap: settings.voice.stepCap,
  replyMaxChars: settings.voice.replyMaxChars,
  canChange,
});

export function registerVoiceSettingsRoutes(app, { express, host, requestScope, mittrSettings, logger = console }) {
  const readJson = jsonBody(express, { limit: BODY_LIMIT });
  const local = (req) => isLocalRequest(req, { host, requestScope });

  const fromThisMac = (req, res, next) => (local(req) ? next() : res.status(403).json({ error: ONLY_ON_THIS_MAC }));

  const settingsOrNull = () => mittrSettings.read().catch((error) => {
    logger.warn('[mittr] could not read the voice settings:', error?.message ?? error);
    return null;
  });

  app.get(ROUTE, async (req, res) => {
    const settings = await settingsOrNull();
    if (!settings) return res.status(500).json({ error: CANNOT_READ });
    return res.json(viewOf(settings, local(req)));
  });

  app.put(ROUTE, fromThisMac, readJson, async (req, res) => {
    const refusal = refusalOf(req.body);
    if (refusal) return res.status(400).json({ error: refusal });
    try {
      return res.json(viewOf(await mittrSettings.update({ voice: req.body }), true));
    } catch (error) {
      logger.warn('[mittr] a voice setting could not be stored:', error?.message ?? error);
      return res.status(500).json({ error: CANNOT_STORE });
    }
  });
}

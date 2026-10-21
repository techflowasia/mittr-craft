import { keepConfigured } from './catalog-cache.js';
import { parseCatalog } from './catalog.js';
import { jsonBody } from './json-body.js';
import { CANNOT_REACH_MITTR, PLATFORM_TIMEOUT_MS } from './platform.js';
import { MITTR_PROVIDER_ID } from './policies.js';
import { isRecord } from './values.js';

// The platform's desktop catalog: the organisation's roster for the person
// the token belongs to, never anyone's personal agents. No `/api` prefix: on
// the platform that path belongs to its auth middleware.
const CATALOG_ENDPOINT = '/desktop/catalog';

const NOT_SIGNED_IN = 'Not signed in to Mittr';
const REFUSED = 'Mittr refused the catalog request';
const CANNOT_STORE = 'Cannot store the Mittr catalog on this machine';

// The platform's refusal code (`desktop_entitlement_required`) is passed on
// when it is a plain code, so the window can say why; anything else is not.
const REFUSAL_CODE = /^[a-z][a-z0-9_]{0,63}$/;

const EMPTY_COLLECTION = { configured: false, items: [] };

const SWITCHABLE_KINDS = ['mcp', 'skills'];
const BAD_ENABLEMENT = 'kind must be mcp or skills, and name is required';
const ENABLEMENT_BODY_LIMIT = '8kb';

const CONNECTOR_TEXT_FIELDS = ['name', 'title', 'displayName', 'label', 'description'];
const CONNECTOR_TYPES = ['local', 'remote'];

const hostOf = (url) => {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
};

const connectorView = (item) => {
  const view = Object.fromEntries(CONNECTOR_TEXT_FIELDS.filter((field) => typeof item[field] === 'string').map((field) => [field, item[field]]));
  const source = isRecord(item.config) ? item.config : item;
  if (CONNECTOR_TYPES.includes(source.type)) view.type = source.type;
  const host = source.type === 'remote' && typeof source.url === 'string' ? hostOf(source.url) : null;
  if (host) view.host = host;
  return view;
};

const withEnablement = (collection, kind, enablement) => ({
  configured: collection.configured,
  items: collection.items.map((item) => {
    if (!isRecord(item)) return kind === 'mcp' ? {} : item;
    const enabled = kind === 'models' || enablement.isEnabled(kind, String(item.name ?? item.alias ?? ''));
    return { ...(kind === 'mcp' ? connectorView(item) : item), enabled };
  }),
});

const refusalCodeOf = async (response) => {
  try {
    const body = await response.json();
    return typeof body?.message === 'string' && REFUSAL_CODE.test(body.message) ? body.message : null;
  } catch {
    return null;
  }
};

/**
 * The Mittr catalog on the server: `GET /api/mittr/catalog` answers the
 * active account's cached catalog, and `POST /api/mittr/catalog/sync` fetches
 * it again. Both sit under `/api`, so they carry the UI's own auth.
 *
 * `cache()` resolves the active account's cache on every request and sync, so
 * a sync after a switch writes the new account's file. A sync whose account
 * changed while it was out files the answer under the account it was asked
 * for and applies nothing: the models on screen belong to someone else now.
 *
 * `onModels(items)` hears the new model list whenever the catalog carries
 * one, empty included. A failed, refused or unusable sync keeps the last
 * catalog and calls nobody: replacing it with nothing would take every model
 * away over a network blip.
 *
 * Syncs run one after another, so an older answer never lands over a newer
 * one. Returns `{ sync, syncStored }`: `sync` reports rather than throws,
 * and `syncStored` resolves as soon as the fetched catalog is stored, or when
 * the sync ends without one, with the models applied a turn later.
 */
export function registerMittrCatalogRoutes(app, {
  express,
  broker,
  ensureFreshSession,
  cache,
  enablement,
  onModels,
  onCatalog = async () => {},
  onEnablementChange = async () => {},
  fetchImpl = (...args) => fetch(...args),
  logger = console,
}) {
  const endpoint = new URL(CATALOG_ENDPOINT, broker.baseUrl).toString();
  const failure = (status, error, extra = {}) => ({ status, body: { error, ...extra } });

  const runSync = async ({ onStored } = {}) => {
    // Refreshed first: a sync is often the first call after a long idle, just
    // when the access token has run out on a session that is still good.
    const session = await ensureFreshSession();
    if (!session?.accessToken) return failure(401, NOT_SIGNED_IN);
    const target = cache();

    let response;
    try {
      response = await fetchImpl(endpoint, {
        headers: { authorization: `Bearer ${session.accessToken}` },
        signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
      });
    } catch (error) {
      logger.error('[mittr] catalog sync failed:', error?.message ?? error);
      return failure(502, CANNOT_REACH_MITTR);
    }

    if (!response.ok) {
      const code = await refusalCodeOf(response);
      return failure(response.status, REFUSED, code ? { code } : {});
    }

    let catalog;
    try {
      catalog = parseCatalog(await response.json());
    } catch (error) {
      return failure(502, `Mittr served an unusable catalog: ${error?.message ?? error}`);
    }

    const stored = keepConfigured(target.read(), catalog);
    try {
      target.write(stored);
    } catch (error) {
      // Applied only once stored: the cache is what the next start, the
      // catalog route and the shim's model list all read.
      logger.error('[mittr] could not store the Mittr catalog:', error?.message ?? error);
      return failure(500, CANNOT_STORE);
    }

    if (onStored) {
      onStored();
      await new Promise((resolve) => { setImmediate(resolve); });
    }

    if (cache() === target) {
      if (stored.models.configured) {
        try {
          await onModels(stored.models.items);
        } catch (error) {
          logger.warn('[mittr] applying the Mittr models failed:', error?.message ?? error);
        }
      }
      if (cache() === target) {
        try {
          await onCatalog(stored);
        } catch (error) {
          logger.warn('[mittr] applying the Mittr catalog failed:', error?.message ?? error);
        }
      }
    }
    return { status: 200, body: { bundleVersion: catalog.bundleVersion } };
  };

  const queue = [];
  let busy = false;
  const drain = async () => {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const entry = queue.shift();
      let result;
      try {
        result = await runSync({ onStored: () => entry.listeners.forEach((listener) => listener()) });
      } catch (error) {
        logger.error('[mittr] catalog sync failed:', error?.message ?? error);
        result = failure(500, 'The Mittr catalog sync failed');
      }
      entry.settle(result);
    }
    busy = false;
  };

  const sync = ({ onStored } = {}) => {
    const key = cache();
    const waiting = queue.find((entry) => entry.key === key);
    if (waiting) {
      if (onStored) waiting.listeners.push(onStored);
      return waiting.result;
    }
    const entry = { key, listeners: onStored ? [onStored] : [] };
    entry.result = new Promise((settle) => { entry.settle = settle; });
    queue.push(entry);
    void drain();
    return entry.result;
  };

  const syncStored = () => new Promise((resolve) => {
    void sync({ onStored: resolve }).then(resolve);
  });

  app.post('/api/mittr/catalog/sync', async (_req, res) => {
    const { status, body } = await sync();
    return res.status(status).json(body);
  });

  app.get('/api/mittr/catalog', (_req, res) => {
    const catalog = cache().read();
    return res.json({
      providerId: MITTR_PROVIDER_ID,
      bundleVersion: catalog?.bundleVersion ?? null,
      models: withEnablement(catalog?.models ?? EMPTY_COLLECTION, 'models', enablement),
      mcp: withEnablement(catalog?.mcp ?? EMPTY_COLLECTION, 'mcp', enablement),
      skills: withEnablement(catalog?.skills ?? EMPTY_COLLECTION, 'skills', enablement),
    });
  });

  app.put('/api/mittr/catalog/enablement', jsonBody(express, { limit: ENABLEMENT_BODY_LIMIT }), async (req, res) => {
    const { kind, name, enabled } = isRecord(req.body) ? req.body : {};
    if (typeof kind !== 'string' || !SWITCHABLE_KINDS.includes(kind) || typeof name !== 'string' || !name) {
      return res.status(400).json({ error: BAD_ENABLEMENT });
    }
    try {
      enablement.setEnabled(kind, name, enabled !== false);
    } catch (error) {
      logger.error('[mittr] could not store the catalog enablement:', error?.message ?? error);
      return res.status(500).json({ error: 'Cannot store the choice on this machine' });
    }
    try {
      await onEnablementChange(kind, name);
    } catch (error) {
      logger.warn('[mittr] applying the catalog enablement failed:', error?.message ?? error);
      return res.json({ ok: true, applied: false });
    }
    return res.json({ ok: true });
  });

  return { sync, syncStored };
}

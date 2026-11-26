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
const ACCOUNT_CHANGED = 'The Mittr account changed during the sync';

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

const enablementName = (kind, name) => (kind === 'skills' ? name.trim() : name);

const withEnablement = (collection, kind, enablement) => ({
  configured: collection.configured,
  items: collection.items.map((item) => {
    if (!isRecord(item)) return kind === 'mcp' ? {} : item;
    const enabled = kind === 'models' || enablement.isEnabled(kind, enablementName(kind, String(item.name ?? item.alias ?? '')));
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
 * it again. Both sit under `/api`, so they carry the UI's own auth. Sync is
 * forced by default; `{ force: false }` reuses a successful applied sync for
 * 60 seconds within the same account generation and server run.
 *
 * `cache()` resolves the active account's cache on every request and sync, so
 * a sync after a switch writes the new account's file. A sync whose account
 * changed while it was out files the answer under the account it was asked
 * for and applies nothing, answering 409. The generation also fences a
 * switch away and back to the same account while the request is in flight.
 *
 * `onModels(items)` hears the new model list whenever the catalog carries
 * one, empty included. Omitted models retain that account's prior configured
 * list. A failed, refused or unusable fetch keeps the last catalog and calls
 * nobody. An application failure retains the newly stored catalog, answers
 * 500 with `{ error, bundleVersion, stored: true, applied: false }`, and leaves
 * freshness unset so the same version can be retried.
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
  now = Date.now,
  accountGeneration = () => 0,
}) {
  const endpoint = new URL(CATALOG_ENDPOINT, broker.baseUrl).toString();
  const failure = (status, error, extra = {}) => ({ status, body: { error, ...extra } });

  let fresh = null;
  const runSync = async ({ key: target, generation, force, onStored }) => {
    const isCurrent = () => cache() === target && accountGeneration() === generation;
    if (!isCurrent()) return failure(409, ACCOUNT_CHANGED);
    if (!force && fresh?.key === target && fresh.generation === generation && now() - fresh.at < 60_000) {
      return fresh.result;
    }
    // A failed forced attempt also invalidates prior freshness.
    fresh = null;
    // Refreshed first: a sync is often the first call after a long idle, just
    // when the access token has run out on a session that is still good.
    const session = await ensureFreshSession();
    if (!isCurrent()) return failure(409, ACCOUNT_CHANGED);
    if (!session?.accessToken) return failure(401, NOT_SIGNED_IN);

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

    if (!isCurrent()) return failure(409, ACCOUNT_CHANGED);
    let applied = true;
    if (stored.models.configured) {
      try {
        await onModels(stored.models.items);
      } catch (error) {
        applied = false;
        logger.warn('[mittr] applying the Mittr models failed:', error?.message ?? error);
      }
    }
    if (!isCurrent()) return failure(409, ACCOUNT_CHANGED);
    if (applied) {
      try {
        await onCatalog(stored);
      } catch (error) {
        applied = false;
        logger.warn('[mittr] applying the Mittr catalog failed:', error?.message ?? error);
      }
    }
    if (!isCurrent()) return failure(409, ACCOUNT_CHANGED);
    if (!applied) return failure(500, 'Cannot apply the Mittr catalog', { bundleVersion: catalog.bundleVersion, stored: true, applied: false });
    const result = { status: 200, body: { bundleVersion: catalog.bundleVersion } };
    fresh = { key: target, generation, at: now(), result };
    return result;
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
        result = await runSync({ ...entry, onStored: () => entry.listeners.forEach((listener) => listener()) });
      } catch (error) {
        logger.error('[mittr] catalog sync failed:', error?.message ?? error);
        result = failure(500, 'The Mittr catalog sync failed');
      }
      entry.settle(result);
    }
    busy = false;
  };

  const sync = ({ onStored, force = true } = {}) => {
    const key = cache();
    const generation = accountGeneration();
    const waiting = queue.find((entry) => entry.key === key && entry.generation === generation);
    if (waiting) {
      if (onStored) waiting.listeners.push(onStored);
      if (force) waiting.force = true;
      return waiting.result;
    }
    const entry = { key, generation, force, listeners: onStored ? [onStored] : [] };
    entry.result = new Promise((settle) => { entry.settle = settle; });
    queue.push(entry);
    void drain();
    return entry.result;
  };

  const syncStored = () => new Promise((resolve) => {
    void sync({ onStored: resolve }).then(resolve);
  });

  app.post('/api/mittr/catalog/sync', jsonBody(express, { limit: ENABLEMENT_BODY_LIMIT }), async (req, res) => {
    if (req.body !== undefined && (!isRecord(req.body) || (req.body.force !== undefined && ![true, false].includes(req.body.force)))) {
      return res.status(400).json({ error: 'force must be a boolean' });
    }
    const { status, body } = await sync({ force: req.body?.force !== false });
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
    const { kind, name: given, enabled } = isRecord(req.body) ? req.body : {};
    if (typeof kind !== 'string' || !SWITCHABLE_KINDS.includes(kind) || typeof given !== 'string') {
      return res.status(400).json({ error: BAD_ENABLEMENT });
    }
    const name = enablementName(kind, given);
    if (!name) return res.status(400).json({ error: BAD_ENABLEMENT });
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

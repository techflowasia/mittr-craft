import { parseCatalog } from './catalog.js';
import { CANNOT_REACH_MITTR, PLATFORM_TIMEOUT_MS } from './platform.js';
import { MITTR_PROVIDER_ID } from './policies.js';

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
  broker,
  ensureFreshSession,
  cache,
  onModels,
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

    try {
      target.write(catalog);
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

    if (catalog.models.configured && cache() === target) {
      try {
        await onModels(catalog.models.items);
      } catch (error) {
        logger.warn('[mittr] applying the Mittr models failed:', error?.message ?? error);
      }
    }
    return { status: 200, body: { bundleVersion: catalog.bundleVersion } };
  };

  let last = Promise.resolve();
  const sync = (options) => {
    const run = last.then(() => runSync(options));
    last = run.catch(() => {});
    return run.catch((error) => {
      logger.error('[mittr] catalog sync failed:', error?.message ?? error);
      return failure(500, 'The Mittr catalog sync failed');
    });
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
      models: catalog?.models ?? EMPTY_COLLECTION,
      mcp: catalog?.mcp ?? EMPTY_COLLECTION,
      skills: catalog?.skills ?? EMPTY_COLLECTION,
    });
  });

  return { sync, syncStored };
}

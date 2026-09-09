import express from 'express';
import { parseCatalog } from './catalog.js';

// Each route brings its own body parser: the application does not parse JSON
// globally. See auth-routes.js.
const readJson = (limit) => express.json({ limit });

// Mittr's desktop catalog endpoint. No `/api` prefix: that path belongs to
// Better Auth's middleware on the platform side and 404s. See auth-routes.js.
const CATALOG_ENDPOINT = '/desktop/catalog';

// Models are not a developer's to switch off: removing bring-your-own-key is
// the whole point of the catalog (spec §7).
const SWITCHABLE_KINDS = ['mcp', 'skills'];

const withEnablement = (collection, kind, enablement) => ({
  configured: collection.configured,
  items: collection.items.map((item) => ({
    ...item,
    enabled: enablement.isEnabled(kind, item.name ?? item.alias),
  })),
});

const EMPTY_COLLECTION = { configured: false, items: [] };

export function registerMittrCatalogRoutes(app, {
  brokerBaseUrl,
  ensureFreshSession,
  cache,
  enablement,
  syncModels,
  reconcile = null,
  fetchImpl = fetch,
}) {
  const sync = async () => {
    // The access token is refreshed first. A catalog sync is often the first
    // call after a long idle period, which is exactly when the token has
    // expired and a raw read would 401 on a session that is perfectly good.
    const session = await ensureFreshSession();
    if (!session?.accessToken) return { status: 401, body: { error: 'Not signed in to Mittr' } };

    let response;
    try {
      response = await fetchImpl(new URL(CATALOG_ENDPOINT, brokerBaseUrl).toString(), {
        headers: { authorization: `Bearer ${session.accessToken}` },
      });
    } catch (error) {
      // The previous catalog stays exactly as it was. Replacing it with nothing
      // would uninstall every organisation entry over a network blip.
      console.error('[mittr] catalog sync failed:', error?.message ?? error);
      return { status: 502, body: { error: 'Cannot reach Mittr' } };
    }

    if (!response.ok) {
      return { status: response.status, body: { error: 'Mittr refused the catalog request' } };
    }

    let catalog;
    try {
      catalog = parseCatalog(await response.json());
    } catch (error) {
      return { status: 502, body: { error: `Mittr served an unusable catalog: ${error.message}` } };
    }

    cache.write(catalog);
    if (catalog.models.configured) await syncModels(catalog.models.items);
    if (reconcile) await reconcile(catalog);
    return { status: 200, body: { bundleVersion: catalog.bundleVersion } };
  };

  app.post('/api/mittr/catalog/sync', async (_req, res) => {
    const { status, body } = await sync();
    return res.status(status).json(body);
  });

  app.get('/api/mittr/catalog', (_req, res) => {
    const catalog = cache.read();
    if (!catalog) {
      return res.json({
        bundleVersion: null,
        models: EMPTY_COLLECTION,
        mcp: EMPTY_COLLECTION,
        skills: EMPTY_COLLECTION,
      });
    }
    return res.json({
      bundleVersion: catalog.bundleVersion,
      models: withEnablement(catalog.models ?? EMPTY_COLLECTION, 'models', enablement),
      mcp: withEnablement(catalog.mcp ?? EMPTY_COLLECTION, 'mcp', enablement),
      skills: withEnablement(catalog.skills ?? EMPTY_COLLECTION, 'skills', enablement),
    });
  });

  app.put('/api/mittr/catalog/enablement', readJson('8kb'), (req, res) => {
    const kind = String(req.body?.kind ?? '');
    const name = String(req.body?.name ?? '');
    if (!SWITCHABLE_KINDS.includes(kind) || !name) {
      return res.status(400).json({ error: 'kind must be mcp or skills, and name is required' });
    }
    enablement.setEnabled(kind, name, req.body?.enabled !== false);
    return res.json({ ok: true });
  });

  // Startup and post-sign-in both need a sync that reports rather than answers.
  return { sync };
}

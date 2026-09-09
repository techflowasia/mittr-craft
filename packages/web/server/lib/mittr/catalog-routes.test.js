import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerMittrCatalogRoutes } from './catalog-routes.js';

const ALIAS = 'pm_9f2c1d4e7b';

const memoryCache = () => {
  let value = null;
  return { read: () => value, write: (v) => { value = v; } };
};

const catalogPayload = {
  bundleVersion: 7,
  models: [{ alias: ALIAS, label: 'MittrCraft 1.0' }],
  mcp: [],
};

const createApp = ({
  fetchImpl,
  cache = memoryCache(),
  syncModels = vi.fn(),
  session = { accessToken: 'at-1' },
  reconcile = undefined,
} = {}) => {
  const app = express();
  app.use(express.json());
  const enablementState = {};
  registerMittrCatalogRoutes(app, {
    brokerBaseUrl: 'https://mittr.test',
    ensureFreshSession: async () => session,
    cache,
    enablement: {
      isEnabled: (kind, name) => !enablementState[`${kind}:${name}`],
      setEnabled: (kind, name, on) => { enablementState[`${kind}:${name}`] = !on; },
    },
    syncModels,
    reconcile,
    fetchImpl,
  });
  return { app, cache, syncModels, enablementState };
};

const ok = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});

describe('mittr catalog routes', () => {
  it('fetches, caches and hands the models to the provider registrar', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(catalogPayload));
    const { app, cache, syncModels } = createApp({ fetchImpl });

    await request(app).post('/api/mittr/catalog/sync').expect(200);

    expect(fetchImpl.mock.calls[0][0]).toBe('https://mittr.test/desktop/catalog');
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer at-1');
    expect(cache.read().bundleVersion).toBe(7);
    expect(syncModels).toHaveBeenCalledWith([{ alias: ALIAS, label: 'MittrCraft 1.0' }]);
  });

  it('passes the alias through untouched, because only Mittr can resolve it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(catalogPayload));
    const { app, syncModels } = createApp({ fetchImpl });
    await request(app).post('/api/mittr/catalog/sync').expect(200);
    expect(syncModels.mock.calls[0][0][0].alias).toBe(ALIAS);
  });

  it('keeps the cached catalog when the broker is unreachable', async () => {
    const cache = memoryCache();
    cache.write({ bundleVersion: 6, models: { configured: true, items: [] }, mcp: { configured: false, items: [] } });
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const { app } = createApp({ fetchImpl, cache });

    await request(app).post('/api/mittr/catalog/sync').expect(502);
    expect(cache.read().bundleVersion).toBe(6);
  });

  it('serves the cached catalog with each item marked enabled or not', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ ...catalogPayload, mcp: [{ name: 'jira' }] }));
    const { app } = createApp({ fetchImpl });
    await request(app).post('/api/mittr/catalog/sync').expect(200);

    const res = await request(app).get('/api/mittr/catalog').expect(200);
    expect(res.body.mcp.items[0]).toEqual({ name: 'jira', enabled: true });
  });

  it('records a disable and reflects it on the next read', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ ...catalogPayload, mcp: [{ name: 'jira' }] }));
    const { app } = createApp({ fetchImpl });
    await request(app).post('/api/mittr/catalog/sync').expect(200);

    await request(app)
      .put('/api/mittr/catalog/enablement')
      .send({ kind: 'mcp', name: 'jira', enabled: false })
      .expect(200);

    const res = await request(app).get('/api/mittr/catalog').expect(200);
    expect(res.body.mcp.items[0].enabled).toBe(false);
  });

  it('refuses to switch off a model, which the platform decides and not the developer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(catalogPayload));
    const { app } = createApp({ fetchImpl });
    await request(app)
      .put('/api/mittr/catalog/enablement')
      .send({ kind: 'models', name: ALIAS, enabled: false })
      .expect(400);
  });

  it('reconciles connectors after a successful sync', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ ...catalogPayload, mcp: [{ name: 'jira' }] }));
    const reconcile = vi.fn();
    const { app } = createApp({ fetchImpl, reconcile });
    await request(app).post('/api/mittr/catalog/sync').expect(200);
    expect(reconcile.mock.calls[0][0].mcp.items).toEqual([{ name: 'jira' }]);
  });

  it('does not reconcile when the broker refused, so a bad answer cannot uninstall anything', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 403 }));
    const reconcile = vi.fn();
    const syncModels = vi.fn();
    const { app } = createApp({ fetchImpl, reconcile, syncModels });
    await request(app).post('/api/mittr/catalog/sync').expect(403);
    expect(reconcile).not.toHaveBeenCalled();
    expect(syncModels).not.toHaveBeenCalled();
  });

  it('refuses to sync when nobody is signed in', async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp({ fetchImpl, session: null });
    await request(app).post('/api/mittr/catalog/sync').expect(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('serves an unconfigured catalog before the first sync', async () => {
    const { app } = createApp({ fetchImpl: vi.fn() });
    const res = await request(app).get('/api/mittr/catalog').expect(200);
    expect(res.body).toEqual({
      bundleVersion: null,
      models: { configured: false, items: [] },
      mcp: { configured: false, items: [] },
      skills: { configured: false, items: [] },
    });
  });
});

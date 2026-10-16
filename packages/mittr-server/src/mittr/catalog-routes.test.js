import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { catalogCachePath, createCatalogCache } from './catalog-cache.js';
import { registerMittrCatalogRoutes } from './catalog-routes.js';
import { deferred, fakeFetch, json, serve, tempDataDir } from './test-helpers.js';

const BROKER = { baseUrl: 'https://api-dev.mittr.asia', upstreamV1: 'https://api-dev.mittr.asia/v1' };
const SESSION = { accessToken: 'at-1', subject: { userId: 'u-a' } };
const PAYLOAD = {
  bundleVersion: 7,
  issuedAt: 1_760_000_000_000,
  subject: { userId: 'u-a', displayName: 'A' },
  models: [{ alias: 'a1', label: 'Writer' }, { alias: 'a2', label: 'Reader' }],
};

const recordingLogger = () => {
  const warnings = [];
  const errors = [];
  return { warnings, errors, log: () => {}, warn: (...args) => warnings.push(args.join(' ')), error: (...args) => errors.push(args.join(' ')) };
};

const setUp = async (t, {
  fetchImpl = fakeFetch(() => json(PAYLOAD)),
  session = SESSION,
  dataDir = tempDataDir(t),
  cache = null,
  onModels = null,
} = {}) => {
  const app = express();
  const logger = recordingLogger();
  const models = [];
  const ownCache = createCatalogCache({ filePath: catalogCachePath(dataDir, null), logger });
  const routes = registerMittrCatalogRoutes(app, {
    broker: BROKER,
    ensureFreshSession: async () => session,
    cache: cache ?? (() => ownCache),
    onModels: onModels ?? (async (items) => { models.push(items); }),
    fetchImpl,
    logger,
  });
  return { ...routes, models, logger, dataDir, fetchImpl, ownCache, call: await serve(t, app) };
};

test('sync fetches the catalog with the account token and writes the cache', async (t) => {
  const { sync, fetchImpl, ownCache, models } = await setUp(t);
  const result = await sync();

  assert.deepEqual(result, { status: 200, body: { bundleVersion: 7 } });
  const [request] = fetchImpl.calls;
  assert.equal(request.url, 'https://api-dev.mittr.asia/desktop/catalog');
  assert.equal(request.headers.authorization, 'Bearer at-1');
  assert.ok(request.signal, 'the platform call has a time limit');
  assert.equal(ownCache.read().bundleVersion, 7);
  assert.equal(models.length, 1);
  assert.deepEqual(models[0], PAYLOAD.models);
});

test('the sync route answers what the sync did', async (t) => {
  const { call } = await setUp(t);
  assert.deepEqual(await call('POST', '/api/mittr/catalog/sync'), { status: 200, body: { bundleVersion: 7 } });
});

test('the catalog route answers the cached catalog under the Mittr provider id', async (t) => {
  const { sync, call } = await setUp(t, { fetchImpl: fakeFetch(() => json({ ...PAYLOAD, skills: [{ name: 's1' }] })) });
  const before = await call('GET', '/api/mittr/catalog');
  assert.deepEqual(before.body, {
    providerId: 'mittr',
    bundleVersion: null,
    models: { configured: false, items: [] },
    mcp: { configured: false, items: [] },
    skills: { configured: false, items: [] },
  });

  await sync();
  const after = await call('GET', '/api/mittr/catalog');
  assert.deepEqual(after.body, {
    providerId: 'mittr',
    bundleVersion: 7,
    models: { configured: true, items: PAYLOAD.models },
    mcp: { configured: false, items: [] },
    skills: { configured: true, items: [{ name: 's1' }] },
  });
});

test('a sync with nobody signed in answers 401 and touches nothing', async (t) => {
  const { sync, fetchImpl, ownCache, models } = await setUp(t, { session: null });
  assert.deepEqual(await sync(), { status: 401, body: { error: 'Not signed in to Mittr' } });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(ownCache.read(), null);
  assert.deepEqual(models, []);
});

test('an unreachable Mittr keeps the last catalog and answers 502', async (t) => {
  const { sync, ownCache, models, logger } = await setUp(t, { fetchImpl: fakeFetch(() => { throw new Error('ECONNREFUSED'); }) });
  ownCache.write({ bundleVersion: 3, subject: null, models: { configured: true, items: [{ alias: 'old' }] }, mcp: { configured: false, items: [] }, skills: { configured: false, items: [] }, knowledge: { configured: false, items: [] } });
  assert.deepEqual(await sync(), { status: 502, body: { error: 'Cannot reach Mittr' } });
  assert.equal(ownCache.read().bundleVersion, 3);
  assert.deepEqual(models, []);
  assert.equal(logger.errors.length, 1);
  assert.equal(logger.errors[0].includes('at-1'), false);
});

test('empty models remove the provider\'s models but keep the cache shape', async (t) => {
  const { sync, ownCache, models } = await setUp(t, { fetchImpl: fakeFetch(() => json({ ...PAYLOAD, models: [] })) });
  assert.equal((await sync()).status, 200);
  assert.deepEqual(models, [[]]);
  assert.equal(ownCache.read().models.configured, true);
  assert.deepEqual(ownCache.read().models.items, []);
});

test('a catalog that does not carry models leaves the model list alone', async (t) => {
  const { sync, ownCache, models } = await setUp(t, { fetchImpl: fakeFetch(() => json({ bundleVersion: 9, mcp: [] })) });
  assert.equal((await sync()).status, 200);
  assert.deepEqual(models, []);
  assert.equal(ownCache.read().models.configured, false);
});

test('refused catalog keeps the last list', async (t) => {
  const refused = json({ message: 'desktop_entitlement_required', error: 'Forbidden', statusCode: 403 }, 403);
  const { sync, ownCache, models } = await setUp(t, { fetchImpl: fakeFetch(() => refused) });
  ownCache.write({ bundleVersion: 3, subject: null, models: { configured: true, items: [{ alias: 'old' }] }, mcp: { configured: false, items: [] }, skills: { configured: false, items: [] }, knowledge: { configured: false, items: [] } });

  const result = await sync();
  assert.equal(result.status, 403);
  assert.deepEqual(result.body, { error: 'Mittr refused the catalog request', code: 'desktop_entitlement_required' });
  assert.deepEqual(models, []);
  assert.equal(ownCache.read().bundleVersion, 3);
});

test('an unusable catalog keeps the last list and answers 502', async (t) => {
  const { sync, ownCache, models } = await setUp(t, { fetchImpl: fakeFetch(() => json({ models: [] })) });
  const result = await sync();
  assert.equal(result.status, 502);
  assert.match(result.body.error, /^Mittr served an unusable catalog: .*bundleVersion/);
  assert.equal(ownCache.read(), null);
  assert.deepEqual(models, []);
});

test('a catalog that cannot be stored is not applied', async (t) => {
  const dataDir = tempDataDir(t);
  fs.mkdirSync(path.join(dataDir, 'mittr-catalog.json'));
  const { sync, models, logger } = await setUp(t, { dataDir });
  assert.deepEqual(await sync(), { status: 500, body: { error: 'Cannot store the Mittr catalog on this machine' } });
  assert.deepEqual(models, []);
  assert.equal(logger.errors.length, 1);
});

test('a model listener that throws does not turn the sync into a rejection', async (t) => {
  const { sync, logger } = await setUp(t, { onModels: async () => { throw new Error('config write failed'); } });
  assert.deepEqual(await sync(), { status: 200, body: { bundleVersion: 7 } });
  assert.equal(logger.warnings.length, 1);
});

test('a sync after a switch writes the new account\'s cache', async (t) => {
  const dataDir = tempDataDir(t);
  const cacheA = createCatalogCache({ filePath: catalogCachePath(dataDir, '000000000000000a') });
  const cacheB = createCatalogCache({ filePath: catalogCachePath(dataDir, '000000000000000b') });
  let active = cacheA;
  let version = 7;
  const { sync, models } = await setUp(t, { dataDir, cache: () => active, fetchImpl: fakeFetch(() => json({ ...PAYLOAD, bundleVersion: version })) });

  await sync();
  assert.equal(cacheA.read().bundleVersion, 7);
  assert.equal(cacheB.read(), null);

  active = cacheB;
  version = 8;
  await sync();
  assert.equal(cacheA.read().bundleVersion, 7);
  assert.equal(cacheB.read().bundleVersion, 8);
  assert.equal(models.length, 2);
});

test('a sync still in flight when the account switches files its answer under the old account and applies nothing', async (t) => {
  const dataDir = tempDataDir(t);
  const cacheA = createCatalogCache({ filePath: catalogCachePath(dataDir, '000000000000000a') });
  const cacheB = createCatalogCache({ filePath: catalogCachePath(dataDir, '000000000000000b') });
  let active = cacheA;
  const answer = deferred();
  const { sync, models } = await setUp(t, { dataDir, cache: () => active, fetchImpl: fakeFetch(() => answer.promise) });

  const pending = sync();
  await new Promise((resolve) => setTimeout(resolve, 10));
  active = cacheB;
  answer.resolve(json(PAYLOAD));

  assert.equal((await pending).status, 200);
  assert.equal(cacheA.read().bundleVersion, 7);
  assert.equal(cacheB.read(), null);
  assert.deepEqual(models, []);
});

test('syncs run one after another, so an older answer never lands over a newer one', async (t) => {
  const answers = [deferred(), deferred()];
  const { sync, ownCache, models } = await setUp(t, { fetchImpl: fakeFetch((_call, n) => answers[n - 1].promise) });

  const first = sync();
  const second = sync();
  // The later request's answer is ready first; it must still land last.
  answers[1].resolve(json({ ...PAYLOAD, bundleVersion: 8 }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  answers[0].resolve(json({ ...PAYLOAD, bundleVersion: 7 }));
  await Promise.all([first, second]);

  assert.equal(ownCache.read().bundleVersion, 8);
  assert.equal(models.length, 2);
});

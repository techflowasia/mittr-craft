import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { catalogCachePath, createCatalogCache } from './catalog-cache.js';
import { registerMittrCatalogRoutes } from './catalog-routes.js';
import { createEnablementStore } from './enablement.js';
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
  onCatalog = null,
  onEnablementChange = null,
} = {}) => {
  const app = express();
  const logger = recordingLogger();
  const models = [];
  const catalogs = [];
  const changes = [];
  const enablement = createEnablementStore({ filePath: path.join(dataDir, 'mittr-enablement.json') });
  const ownCache = createCatalogCache({ filePath: catalogCachePath(dataDir, null), logger });
  const routes = registerMittrCatalogRoutes(app, {
    express,
    broker: BROKER,
    ensureFreshSession: async () => session,
    cache: cache ?? (() => ownCache),
    onModels: onModels ?? (async (items) => { models.push(items); }),
    onCatalog: onCatalog ?? (async (catalog) => { catalogs.push(catalog); }),
    enablement,
    onEnablementChange: onEnablementChange ?? (async (kind) => { changes.push(kind); }),
    fetchImpl,
    logger,
  });
  return { ...routes, models, catalogs, changes, enablement, logger, dataDir, fetchImpl, ownCache, call: await serve(t, app) };
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
    models: { configured: true, items: PAYLOAD.models.map((model) => ({ ...model, enabled: true })) },
    mcp: { configured: false, items: [] },
    skills: { configured: true, items: [{ name: 's1', enabled: true }] },
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

test('syncStored resolves once the catalog is stored, before the models are applied', async (t) => {
  const applied = deferred();
  const started = [];
  const { syncStored, ownCache } = await setUp(t, {
    onModels: async (items) => {
      started.push(items);
      await applied.promise;
    },
  });
  await syncStored();
  assert.equal(ownCache.read().bundleVersion, 7);
  assert.equal(started.length, 0);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(started.length, 1);
  applied.resolve();
});

test('syncStored resolves when the sync ends without storing anything', async (t) => {
  const { syncStored, ownCache } = await setUp(t, { fetchImpl: fakeFetch(() => json({ message: 'desktop_entitlement_required' }, 403)) });
  await syncStored();
  assert.equal(ownCache.read(), null);
});

const FULL = {
  ...PAYLOAD,
  mcp: [{ name: 'stub-law', type: 'remote', url: 'https://law.example.test/mcp' }],
  skills: [{ name: 'card-analysis' }, { name: 'notes' }],
};

test('the catalog lists enabled per item', async (t) => {
  const { sync, call, enablement } = await setUp(t, { fetchImpl: fakeFetch(() => json(FULL)) });
  await sync();
  enablement.setEnabled('skills', 'card-analysis', false);
  enablement.setEnabled('mcp', 'stub-law', false);
  enablement.setEnabled('mcp', 'a1', false);

  const { body } = await call('GET', '/api/mittr/catalog');
  assert.deepEqual(body.skills.items.map((item) => [item.name, item.enabled]), [['card-analysis', false], ['notes', true]]);
  assert.deepEqual(body.mcp.items.map((item) => [item.name, item.enabled]), [['stub-law', false]]);
  assert.deepEqual(body.models.items.map((item) => [item.alias, item.enabled]), [['a1', true], ['a2', true]]);
  assert.equal(body.skills.configured, true);
});

test('a skill and a connector of one name are enabled separately', async (t) => {
  const { sync, call, enablement } = await setUp(t, { fetchImpl: fakeFetch(() => json({ ...PAYLOAD, mcp: [{ name: 'law' }], skills: [{ name: 'law' }] })) });
  await sync();
  enablement.setEnabled('mcp', 'law', false);
  const { body } = await call('GET', '/api/mittr/catalog');
  assert.equal(body.mcp.items[0].enabled, false);
  assert.equal(body.skills.items[0].enabled, true);
});

test('the enablement route stores a disable and an enable', async (t) => {
  const { call, enablement, changes, dataDir } = await setUp(t);
  assert.deepEqual(await call('PUT', '/api/mittr/catalog/enablement', { kind: 'skills', name: 'card-analysis', enabled: false }), { status: 200, body: { ok: true } });
  assert.equal(enablement.isEnabled('skills', 'card-analysis'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'mittr-enablement.json'), 'utf8')).skills['card-analysis'].disabled, true);

  assert.deepEqual(await call('PUT', '/api/mittr/catalog/enablement', { kind: 'skills', name: 'card-analysis', enabled: true }), { status: 200, body: { ok: true } });
  assert.equal(enablement.isEnabled('skills', 'card-analysis'), true);
  assert.deepEqual(changes, ['skills', 'skills']);
});

test('only an explicit false disables', async (t) => {
  const { call, enablement } = await setUp(t);
  await call('PUT', '/api/mittr/catalog/enablement', { kind: 'mcp', name: 'stub-law', enabled: false });
  assert.equal(enablement.isEnabled('mcp', 'stub-law'), false);
  await call('PUT', '/api/mittr/catalog/enablement', { kind: 'mcp', name: 'stub-law' });
  assert.equal(enablement.isEnabled('mcp', 'stub-law'), true);
});

test('enablement accepts only mcp and skills', async (t) => {
  const { call, enablement, changes } = await setUp(t);
  const message = { error: 'kind must be mcp or skills, and name is required' };
  for (const body of [
    { kind: 'models', name: 'x', enabled: false },
    { kind: 'knowledge', name: 'x' },
    { kind: 'skills', name: '' },
    { kind: 'skills' },
    { name: 'x' },
    {},
    { kind: ['skills'], name: 'x' },
  ]) {
    assert.deepEqual(await call('PUT', '/api/mittr/catalog/enablement', body), { status: 400, body: message }, JSON.stringify(body));
  }
  assert.deepEqual(enablement.all(), {});
  assert.deepEqual(changes, []);
});

test('an enablement body that is too large or not JSON is refused before it is read', async (t) => {
  const { call } = await setUp(t);
  const large = await call('PUT', '/api/mittr/catalog/enablement', { kind: 'skills', name: 'x'.repeat(9000) });
  assert.deepEqual(large, { status: 413, body: { error: 'Invalid request body' } });
  const broken = await fetch(`${call.base}/api/mittr/catalog/enablement`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{ nope' });
  assert.equal(broken.status, 400);
  assert.deepEqual(await broken.json(), { error: 'Invalid request body' });
});

test('a change is announced for its kind', async (t) => {
  const { call, changes } = await setUp(t);
  await call('PUT', '/api/mittr/catalog/enablement', { kind: 'skills', name: 'card-analysis', enabled: false });
  assert.deepEqual(changes, ['skills']);
});

test('the choice is stored even when announcing it fails', async (t) => {
  const { call, enablement, logger } = await setUp(t, { onEnablementChange: async () => { throw new Error('config write failed'); } });
  assert.deepEqual(await call('PUT', '/api/mittr/catalog/enablement', { kind: 'mcp', name: 'stub-law', enabled: false }), { status: 200, body: { ok: true } });
  assert.equal(enablement.isEnabled('mcp', 'stub-law'), false);
  assert.equal(logger.warnings.length, 1);
});

test('a disable survives a sync that brings the item again', async (t) => {
  const { sync, call, enablement } = await setUp(t, { fetchImpl: fakeFetch(() => json(FULL)) });
  await sync();
  enablement.setEnabled('skills', 'notes', false);
  await sync();
  const { body } = await call('GET', '/api/mittr/catalog');
  assert.equal(body.skills.items.find((item) => item.name === 'notes').enabled, false);
});

const cacheWith = (cache, collections) => cache.write({
  bundleVersion: 3,
  subject: null,
  models: { configured: true, items: [{ alias: 'old' }] },
  mcp: { configured: false, items: [] },
  skills: { configured: false, items: [] },
  knowledge: { configured: false, items: [] },
  ...collections,
});

test('an unconfigured collection keeps the last configured one for that account', async (t) => {
  const { sync, ownCache, catalogs } = await setUp(t, { fetchImpl: fakeFetch(() => json(PAYLOAD)) });
  cacheWith(ownCache, {
    skills: { configured: true, items: [{ name: 'card-analysis' }] },
    mcp: { configured: true, items: [{ name: 'stub-law' }] },
  });

  assert.equal((await sync()).status, 200);
  assert.deepEqual(ownCache.read().skills, { configured: true, items: [{ name: 'card-analysis' }] });
  assert.deepEqual(ownCache.read().mcp, { configured: true, items: [{ name: 'stub-law' }] });
  assert.equal(ownCache.read().bundleVersion, 7);
  assert.deepEqual(catalogs[0].skills.items, [{ name: 'card-analysis' }]);
});

test('a configured empty collection replaces it', async (t) => {
  const { sync, ownCache } = await setUp(t, { fetchImpl: fakeFetch(() => json({ ...PAYLOAD, skills: [] })) });
  cacheWith(ownCache, { skills: { configured: true, items: [{ name: 'card-analysis' }] } });

  assert.equal((await sync()).status, 200);
  assert.deepEqual(ownCache.read().skills, { configured: true, items: [] });
});

test('a kept collection never crosses to another account', async (t) => {
  const dataDir = tempDataDir(t);
  const cacheA = createCatalogCache({ filePath: catalogCachePath(dataDir, '000000000000000a') });
  const cacheB = createCatalogCache({ filePath: catalogCachePath(dataDir, '000000000000000b') });
  let active = cacheA;
  const { sync } = await setUp(t, { dataDir, cache: () => active, fetchImpl: fakeFetch(() => json(PAYLOAD)) });
  cacheWith(cacheA, { skills: { configured: true, items: [{ name: 'card-analysis' }] } });

  active = cacheB;
  await sync();
  assert.deepEqual(cacheB.read().skills, { configured: false, items: [] });
  assert.deepEqual(cacheA.read().skills, { configured: true, items: [{ name: 'card-analysis' }] });
});

test('the catalog hears every stored sync once, with what was stored', async (t) => {
  const { sync, ownCache, catalogs, models } = await setUp(t, { fetchImpl: fakeFetch(() => json({ bundleVersion: 9, skills: [{ name: 'notes' }] })) });
  await sync();
  assert.equal(catalogs.length, 1);
  assert.deepEqual(catalogs[0], ownCache.read());
  assert.equal(catalogs[0].bundleVersion, 9);
  assert.deepEqual(models, []);

  await sync();
  assert.equal(catalogs.length, 2);
});

test('the catalog hears the kept collections, not the bare answer', async (t) => {
  let answer = { ...FULL };
  const { sync, ownCache, catalogs } = await setUp(t, { fetchImpl: fakeFetch(() => json(answer)) });
  await sync();
  answer = PAYLOAD;
  await sync();
  assert.equal(catalogs.length, 2);
  assert.deepEqual(catalogs[1].skills.items, FULL.skills);
  assert.deepEqual(catalogs[1], ownCache.read());
});

test('the catalog hears a sync whose answer carries no models, and the models hear nobody', async (t) => {
  const { sync, catalogs, models } = await setUp(t, { fetchImpl: fakeFetch(() => json({ bundleVersion: 9, mcp: [] })) });
  await sync();
  assert.equal(catalogs.length, 1);
  assert.deepEqual(models, []);
});

test('the catalog hears nobody when the sync fails, is refused, is unusable or cannot be stored', async (t) => {
  for (const respond of [
    () => { throw new Error('ECONNREFUSED'); },
    () => json({ message: 'desktop_entitlement_required' }, 403),
    () => json({ models: [] }),
  ]) {
    const { sync, catalogs } = await setUp(t, { fetchImpl: fakeFetch(respond) });
    await sync();
    assert.deepEqual(catalogs, []);
  }

  const dataDir = tempDataDir(t);
  fs.mkdirSync(path.join(dataDir, 'mittr-catalog.json'));
  const { sync, catalogs } = await setUp(t, { dataDir });
  await sync();
  assert.deepEqual(catalogs, []);

  const signedOut = await setUp(t, { session: null });
  await signedOut.sync();
  assert.deepEqual(signedOut.catalogs, []);
});

test('the catalog hears nobody when the account changed while the sync was out', async (t) => {
  const dataDir = tempDataDir(t);
  const cacheA = createCatalogCache({ filePath: catalogCachePath(dataDir, '000000000000000a') });
  const cacheB = createCatalogCache({ filePath: catalogCachePath(dataDir, '000000000000000b') });
  let active = cacheA;
  const answer = deferred();
  const { sync, catalogs } = await setUp(t, { dataDir, cache: () => active, fetchImpl: fakeFetch(() => answer.promise) });

  const pending = sync();
  await new Promise((resolve) => setTimeout(resolve, 10));
  active = cacheB;
  answer.resolve(json(PAYLOAD));

  assert.equal((await pending).status, 200);
  assert.deepEqual(catalogs, []);
  assert.equal(cacheA.read().bundleVersion, 7);
  assert.equal(cacheB.read(), null);
});

test('the catalog hears nobody when the account changed while the models were being applied', async (t) => {
  const dataDir = tempDataDir(t);
  const cacheA = createCatalogCache({ filePath: catalogCachePath(dataDir, '000000000000000a') });
  const cacheB = createCatalogCache({ filePath: catalogCachePath(dataDir, '000000000000000b') });
  let active = cacheA;
  const applied = [];
  const { sync, catalogs } = await setUp(t, {
    dataDir,
    cache: () => active,
    onModels: async (items) => {
      applied.push(items);
      active = cacheB;
    },
  });

  assert.equal((await sync()).status, 200);
  assert.equal(applied.length, 1);
  assert.deepEqual(catalogs, []);
  assert.equal(cacheA.read().bundleVersion, 7);
  assert.equal(cacheB.read(), null);
});

test('a catalog listener that throws does not turn the sync into a rejection', async (t) => {
  const { sync, logger } = await setUp(t, { onCatalog: async () => { throw new Error('reconcile failed'); } });
  assert.deepEqual(await sync(), { status: 200, body: { bundleVersion: 7 } });
  assert.equal(logger.warnings.length, 1);
});

test('a catalog listener that throws does not stop the models from being applied', async (t) => {
  const { sync, models } = await setUp(t, { onCatalog: async () => { throw new Error('reconcile failed'); } });
  await sync();
  assert.equal(models.length, 1);
});

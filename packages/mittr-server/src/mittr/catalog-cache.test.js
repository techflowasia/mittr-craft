import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { catalogCachePath, createCatalogCache } from './catalog-cache.js';
import { tempDataDir } from './test-helpers.js';

const catalog = {
  bundleVersion: 7,
  subject: { userId: 'u-a' },
  models: { configured: true, items: [{ alias: 'a1', label: 'Writer' }, { alias: 'a2', label: 'Reader' }] },
  mcp: { configured: false, items: [] },
  skills: { configured: false, items: [] },
  knowledge: { configured: false, items: [] },
};

const recordingLogger = () => {
  const warnings = [];
  return { warnings, log: () => {}, warn: (...args) => warnings.push(args.join(' ')), error: (...args) => warnings.push(args.join(' ')) };
};

test('the cache file per account matches 1.22: the shared home, then each own home', () => {
  assert.equal(catalogCachePath('/data', null), path.join('/data', 'mittr-catalog.json'));
  assert.equal(catalogCachePath('/data', '0123456789abcdef'), path.join('/data', 'mittr-accounts', '0123456789abcdef.catalog.json'));
});

test('a home that is not a plain account key is refused rather than turned into a path', () => {
  for (const home of ['../x', 'a/b', '', '0123456789ABCDEF']) {
    assert.throws(() => catalogCachePath('/data', home), /home/, home);
  }
});

test('nothing cached reads as null, with no warning', (t) => {
  const logger = recordingLogger();
  const cache = createCatalogCache({ filePath: path.join(tempDataDir(t), 'mittr-catalog.json'), logger });
  assert.equal(cache.read(), null);
  assert.deepEqual(logger.warnings, []);
});

test('a written catalog reads back whole, private to the owner, with no temporary file left', (t) => {
  const dataDir = tempDataDir(t);
  const filePath = catalogCachePath(dataDir, '0123456789abcdef');
  const cache = createCatalogCache({ filePath, logger: recordingLogger() });
  cache.write(catalog);
  assert.deepEqual(createCatalogCache({ filePath }).read(), catalog);
  if (process.platform !== 'win32') assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ['0123456789abcdef.catalog.json']);

  cache.write({ ...catalog, bundleVersion: 8, models: { configured: true, items: [] } });
  assert.equal(cache.read().bundleVersion, 8);
  assert.deepEqual(cache.read().models, { configured: true, items: [] });
});

test('an existing cache file with loose permissions is tightened on the next write', (t) => {
  if (process.platform === 'win32') return;
  const filePath = path.join(tempDataDir(t), 'mittr-catalog.json');
  fs.writeFileSync(filePath, '{}', { mode: 0o644 });
  createCatalogCache({ filePath }).write(catalog);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test('corrupt cache is ignored with one warning', (t) => {
  const filePath = path.join(tempDataDir(t), 'mittr-catalog.json');
  const logger = recordingLogger();
  const cache = createCatalogCache({ filePath, logger });
  for (const stored of ['{ not json', JSON.stringify({ bundleVersion: 7, models: [{ alias: 'a1' }] })]) {
    fs.writeFileSync(filePath, stored);
    assert.equal(cache.read(), null, stored);
    assert.equal(cache.read(), null, stored);
  }
  assert.equal(logger.warnings.length, 1);
  assert.ok(logger.warnings[0].includes(filePath), logger.warnings[0]);
});

test('a failed write leaves the last catalog whole and throws', (t) => {
  const dataDir = tempDataDir(t);
  const filePath = path.join(dataDir, 'mittr-catalog.json');
  const cache = createCatalogCache({ filePath });
  cache.write(catalog);
  assert.throws(() => cache.write({ ...catalog, bundleVersion: 8, models: { configured: true, items: [{ alias: 1n }] } }));
  assert.equal(cache.read().bundleVersion, 7);
  assert.deepEqual(fs.readdirSync(dataDir), ['mittr-catalog.json']);
});

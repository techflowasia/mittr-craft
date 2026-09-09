import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCatalogCache } from './catalog-cache.js';

let dir;
const catalog = {
  bundleVersion: 7,
  models: { configured: true, items: [{ alias: 'pm_9f2c1d4e7b' }] },
  mcp: { configured: false, items: [] },
  skills: { configured: false, items: [] },
  knowledge: { configured: false, items: [] },
};

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-catalog-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const cache = () => createCatalogCache({ filePath: path.join(dir, 'catalog.json') });

describe('catalog cache', () => {
  it('returns null before anything is cached', () => {
    expect(cache().read()).toBeNull();
  });

  it('round-trips a catalog', () => {
    cache().write(catalog);
    expect(cache().read()).toEqual(catalog);
  });

  it('treats an unparsable cache as absent rather than throwing at startup', () => {
    fs.writeFileSync(path.join(dir, 'catalog.json'), '{ not json');
    expect(cache().read()).toBeNull();
  });

  it('replaces the previous catalog wholesale', () => {
    const c = cache();
    c.write(catalog);
    c.write({ ...catalog, bundleVersion: 8, models: { configured: true, items: [] } });
    expect(c.read().bundleVersion).toBe(8);
    expect(c.read().models.items).toEqual([]);
  });
});

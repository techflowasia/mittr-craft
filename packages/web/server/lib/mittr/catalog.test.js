import { describe, expect, it } from 'vitest';
import { parseCatalog } from './catalog.js';

const base = { bundleVersion: 7, issuedAt: '2026-09-07T00:00:00Z', subject: { userId: 'u1' } };

// Aliases are opaque: `pm_` and a hash. Fixtures use that shape so nothing in
// this suite can pass while the code assumes a readable name.
const ALIAS = 'pm_9f2c1d4e7b';

describe('parseCatalog', () => {
  it('marks an absent collection as not configured', () => {
    expect(parseCatalog({ ...base }).mcp).toEqual({ configured: false, items: [] });
  });

  it('marks an empty collection as configured and empty', () => {
    expect(parseCatalog({ ...base, mcp: [] }).mcp).toEqual({ configured: true, items: [] });
  });

  it('keeps the items of a populated collection', () => {
    const parsed = parseCatalog({ ...base, models: [{ alias: ALIAS, label: 'MittrCraft 1.0' }] });
    expect(parsed.models).toEqual({
      configured: true,
      items: [{ alias: ALIAS, label: 'MittrCraft 1.0' }],
    });
  });

  it('carries the alias through byte for byte, because Mittr resolves it and we cannot', () => {
    const parsed = parseCatalog({ ...base, models: [{ alias: ALIAS, label: 'MittrCraft 1.0' }] });
    expect(parsed.models.items[0].alias).toBe(ALIAS);
  });

  it('drops a model entry with no alias rather than registering a nameless provider', () => {
    const parsed = parseCatalog({ ...base, models: [{ label: 'nameless' }, { alias: ALIAS }] });
    expect(parsed.models.items).toEqual([{ alias: ALIAS }]);
  });

  it('drops a model whose alias is not a string instead of coercing one', () => {
    const parsed = parseCatalog({ ...base, models: [{ alias: 12345 }, { alias: ALIAS }] });
    expect(parsed.models.items).toEqual([{ alias: ALIAS }]);
  });

  it('rejects a payload with no bundle version, because sync cannot compare it', () => {
    expect(() => parseCatalog({ issuedAt: '2026-09-07T00:00:00Z' })).toThrow(/bundleVersion/);
  });

  it('rejects a collection that is not an array', () => {
    expect(() => parseCatalog({ ...base, mcp: { a: 1 } })).toThrow(/mcp/);
  });
});

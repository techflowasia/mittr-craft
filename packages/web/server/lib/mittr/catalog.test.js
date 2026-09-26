import { describe, expect, it } from 'vitest';
import { parseCatalog } from './catalog.js';

const base = { bundleVersion: 7, issuedAt: '2026-09-07T00:00:00Z', subject: { userId: 'u1' } };

// Aliases are opaque and their shape is not ours to know: it has already
// changed once, from a provider-and-model hash to an agent key. The fixtures
// deliberately use two unlike shapes so nothing in this suite can pass while
// the code assumes either one.
const ALIAS = 'agent-17okpqe';
const OTHER_ALIAS = 'assistant';

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

  it('keeps two agents that share a backend model, because they are not duplicates', () => {
    // Several agents can run the same model with different instructions, RAG
    // and skills. Collapsing them by anything but the alias would silently take
    // one away.
    const parsed = parseCatalog({
      ...base,
      models: [
        { alias: ALIAS, label: 'MittrCraft 1.0' },
        { alias: OTHER_ALIAS, label: 'MittrCraft 1.0' },
      ],
    });
    expect(parsed.models.items.map((m) => m.alias)).toEqual([ALIAS, OTHER_ALIAS]);
  });

  it('rejects a payload with no bundle version, because sync cannot compare it', () => {
    expect(() => parseCatalog({ issuedAt: '2026-09-07T00:00:00Z' })).toThrow(/bundleVersion/);
  });

  it('rejects a collection that is not an array', () => {
    expect(() => parseCatalog({ ...base, mcp: { a: 1 } })).toThrow(/mcp/);
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCatalog } from './catalog.js';

const base = { bundleVersion: 7, issuedAt: 1_760_000_000_000, subject: { userId: 'u1' } };

// Aliases are opaque: they have already changed shape once, from a
// provider-and-model hash to an agent key. The fixtures use two unlike shapes
// so nothing here can pass while the code assumes either one.
const ALIAS = 'agent-17okpqe';
const OTHER_ALIAS = 'assistant';

test('an absent collection is not configured', () => {
  assert.deepEqual(parseCatalog({ ...base }).mcp, { configured: false, items: [] });
  assert.deepEqual(parseCatalog({ ...base, knowledge: null }).knowledge, { configured: false, items: [] });
});

test('an empty collection is configured and empty', () => {
  assert.deepEqual(parseCatalog({ ...base, models: [] }).models, { configured: true, items: [] });
});

test('a populated collection keeps its items, and the alias byte for byte', () => {
  const parsed = parseCatalog({ ...base, models: [{ alias: ALIAS, label: 'Writer' }], skills: [{ name: 's1' }] });
  assert.deepEqual(parsed.models, { configured: true, items: [{ alias: ALIAS, label: 'Writer' }] });
  assert.deepEqual(parsed.skills, { configured: true, items: [{ name: 's1' }] });
  assert.equal(parsed.bundleVersion, 7);
  assert.deepEqual(parsed.subject, { userId: 'u1' });
});

test('a model with no usable alias is dropped, not repaired', () => {
  const parsed = parseCatalog({ ...base, models: [{ label: 'nameless' }, { alias: '   ' }, { alias: 12345 }, null, { alias: ALIAS }] });
  assert.deepEqual(parsed.models.items, [{ alias: ALIAS }]);
});

test('two agents on the same backend model are both kept', () => {
  const parsed = parseCatalog({ ...base, models: [{ alias: ALIAS, label: 'Same' }, { alias: OTHER_ALIAS, label: 'Same' }] });
  assert.deepEqual(parsed.models.items.map((model) => model.alias), [ALIAS, OTHER_ALIAS]);
});

test('a payload without an integer bundle version is refused', () => {
  assert.throws(() => parseCatalog({ models: [] }), /bundleVersion/);
  assert.throws(() => parseCatalog({ bundleVersion: '7', models: [] }), /bundleVersion/);
  assert.throws(() => parseCatalog({ bundleVersion: 7.5, models: [] }), /bundleVersion/);
});

test('a payload that is not an object, or a collection that is not an array, is refused', () => {
  assert.throws(() => parseCatalog(null), /object/);
  assert.throws(() => parseCatalog('catalog'), /object/);
  assert.throws(() => parseCatalog({ ...base, mcp: { a: 1 } }), /mcp/);
});

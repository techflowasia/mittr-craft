import assert from 'node:assert/strict';
import test from 'node:test';

import { catalogMcpEntity } from './mcp-fragment.js';

const recording = () => {
  const calls = [];
  const toEntity = (raw) => {
    calls.push(raw);
    return { converted: true, ...raw };
  };
  return { calls, toEntity };
};

test('a local entry with a command goes to the converter', () => {
  const { calls, toEntity } = recording();
  const raw = { type: 'local', command: ['node', 'x.mjs'], enabled: true };
  assert.deepEqual(catalogMcpEntity(raw, toEntity), { converted: true, ...raw });
  assert.deepEqual(calls, [raw]);
});

test('a remote entry with a url goes to the converter', () => {
  const { calls, toEntity } = recording();
  const raw = { type: 'remote', url: 'https://example.invalid/mcp', headers: { a: 'b' } };
  assert.deepEqual(catalogMcpEntity(raw, toEntity), { converted: true, ...raw });
  assert.equal(calls.length, 1);
});

test('an entry without a type is refused before the converter', () => {
  const { calls, toEntity } = recording();
  assert.equal(catalogMcpEntity({ command: ['node', 'x.mjs'] }, toEntity), null);
  assert.equal(catalogMcpEntity({ enabled: true }, toEntity), null);
  assert.deepEqual(calls, []);
});

test('a local entry without a command is refused', () => {
  const { calls, toEntity } = recording();
  for (const command of [undefined, [], 'node x.mjs', null]) {
    assert.equal(catalogMcpEntity({ type: 'local', command }, toEntity), null, String(command));
  }
  assert.deepEqual(calls, []);
});

test('a local command with an item that is not a non-empty string is refused', () => {
  const { calls, toEntity } = recording();
  assert.equal(catalogMcpEntity({ type: 'local', command: [1, null] }, toEntity), null);
  assert.equal(catalogMcpEntity({ type: 'local', command: [''] }, toEntity), null);
  assert.equal(catalogMcpEntity({ type: 'local', command: ['node', ''] }, toEntity), null);
  assert.deepEqual(calls, []);
});

test('a remote entry without a url is refused', () => {
  const { calls, toEntity } = recording();
  for (const url of [undefined, '', '   ', 42]) {
    assert.equal(catalogMcpEntity({ type: 'remote', url }, toEntity), null, String(url));
  }
  assert.deepEqual(calls, []);
});

test('an unknown type or a value that is not an object is refused', () => {
  const { calls, toEntity } = recording();
  for (const raw of [{ type: 'sse', url: 'https://example.invalid' }, null, undefined, 'local', ['local']]) {
    assert.equal(catalogMcpEntity(raw, toEntity), null, JSON.stringify(raw));
  }
  assert.deepEqual(calls, []);
});

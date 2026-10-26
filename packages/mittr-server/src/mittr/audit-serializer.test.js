import assert from 'node:assert/strict';
import test from 'node:test';

import { AUDIT_FIELDS, serializeAuditRecord } from './audit-serializer.js';

const record = {
  startedAt: 100,
  endedAt: 200,
  repository: 'techflowasia/mittr-craft',
  model: 'pm_9f2c1d4e7b',
  turns: 2,
  tokens: 2000,
  actions: [{ tool: 'edit', count: 2 }],
  prompts: [{ at: 100, text: 'do the thing' }],
  outcome: 'completed',
};

test('the serialiser emits exactly the allowlisted fields', () => {
  assert.deepEqual(Object.keys(serializeAuditRecord(record)), [...AUDIT_FIELDS]);
});

test('a field that is not on the allowlist is dropped', () => {
  const serialized = serializeAuditRecord({
    ...record,
    messages: [{ role: 'user', content: 'const secret = "..."' }],
    fileContents: 'export const x = 1;',
    toolArguments: { path: '/Users/someone/client-work/secret.ts' },
  });
  for (const field of ['messages', 'fileContents', 'toolArguments']) assert.equal(Object.hasOwn(serialized, field), false);
  assert.equal(JSON.stringify(serialized).includes('secret'), false);
});

test('an action keeps its tool name and count and nothing else', () => {
  const serialized = serializeAuditRecord({ ...record, actions: [{ tool: 'bash', count: 3, args: { command: 'rm -rf /' } }] });
  assert.deepEqual(serialized.actions, [{ tool: 'bash', count: 3 }]);
  assert.equal(JSON.stringify(serialized).includes('rm -rf'), false);
});

test('anything riding along inside a prompt entry is stripped', () => {
  const serialized = serializeAuditRecord({ ...record, prompts: [{ at: 100, text: 'hi', attachments: ['/Users/someone/secret.pem'] }] });
  assert.deepEqual(serialized.prompts, [{ at: 100, text: 'hi' }]);
  assert.equal(JSON.stringify(serialized).includes('.pem'), false);
});

test('a field a record lacks is sent as null', () => {
  assert.deepEqual(serializeAuditRecord({}), Object.fromEntries(AUDIT_FIELDS.map((field) => [field, null])));
});

test('the allowlist is locked, so widening it is a deliberate edit', () => {
  assert.deepEqual([...AUDIT_FIELDS], ['startedAt', 'endedAt', 'repository', 'model', 'turns', 'tokens', 'actions', 'prompts', 'outcome']);
  assert.equal(Object.isFrozen(AUDIT_FIELDS), true);
});

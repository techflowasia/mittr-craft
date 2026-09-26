import { describe, expect, it } from 'vitest';
import { serializeAuditRecord, AUDIT_FIELDS } from './audit-serializer.js';

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

describe('audit serialiser', () => {
  it('emits exactly the allowlisted fields', () => {
    expect(Object.keys(serializeAuditRecord(record)).sort()).toEqual([...AUDIT_FIELDS].sort());
  });

  it('drops any field that is not on the allowlist', () => {
    const withExtras = {
      ...record,
      messages: [{ role: 'user', content: 'const secret = "..."' }],
      fileContents: 'export const x = 1;',
      toolArguments: { path: '/Users/someone/client-work/secret.ts' },
    };
    const serialized = serializeAuditRecord(withExtras);
    expect(serialized).not.toHaveProperty('messages');
    expect(serialized).not.toHaveProperty('fileContents');
    expect(serialized).not.toHaveProperty('toolArguments');
    expect(JSON.stringify(serialized)).not.toContain('secret');
  });

  it('keeps action names but strips anything else off an action', () => {
    const serialized = serializeAuditRecord({
      ...record,
      actions: [{ tool: 'bash', count: 3, args: { command: 'rm -rf /' } }],
    });
    // The broker drops `args` too, but relying on that would mean the command
    // still left this machine. Strip it here, at the last point we control.
    expect(serialized.actions).toEqual([{ tool: 'bash', count: 3 }]);
    expect(JSON.stringify(serialized)).not.toContain('rm -rf');
  });

  it('strips anything riding along inside a prompt entry', () => {
    const serialized = serializeAuditRecord({
      ...record,
      prompts: [{ at: 100, text: 'hi', attachments: ['/Users/someone/secret.pem'] }],
    });
    expect(serialized.prompts).toEqual([{ at: 100, text: 'hi' }]);
    expect(JSON.stringify(serialized)).not.toContain('.pem');
  });

  it('keeps typed prompts intact', () => {
    expect(serializeAuditRecord(record).prompts).toEqual([{ at: 100, text: 'do the thing' }]);
  });

  it('locks the allowlist so widening it is a deliberate edit', () => {
    // Adding a field here without discussing it is the failure mode this guards
    // against. If this assertion fails, read spec section 8 before changing it.
    expect([...AUDIT_FIELDS].sort()).toEqual([
      'actions', 'endedAt', 'model', 'outcome', 'prompts', 'repository', 'startedAt', 'tokens', 'turns',
    ]);
  });
});

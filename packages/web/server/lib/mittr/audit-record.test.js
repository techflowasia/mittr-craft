import { describe, expect, it } from 'vitest';
import { createAuditRecord } from './audit-record.js';

const at = (...times) => {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
};

describe('audit record', () => {
  it('counts turns and tokens', () => {
    const record = createAuditRecord({ now: at(0) });
    record.addTurn({ tokens: 1200 });
    record.addTurn({ tokens: 800 });
    const finished = record.finish('completed');
    expect(finished.turns).toBe(2);
    expect(finished.tokens).toBe(2000);
  });

  it('counts tool uses by name and keeps no arguments', () => {
    const record = createAuditRecord({ now: at(0) });
    record.addToolUse('edit');
    record.addToolUse('edit');
    record.addToolUse('bash');
    expect(record.finish('completed').actions).toEqual([
      { tool: 'edit', count: 2 },
      { tool: 'bash', count: 1 },
    ]);
  });

  it('keeps typed instructions in full and in order', () => {
    const record = createAuditRecord({ now: at(10, 20) });
    record.addPrompt('first thing');
    record.addPrompt('second thing');
    expect(record.finish('completed').prompts).toEqual([
      { at: 10, text: 'first thing' },
      { at: 20, text: 'second thing' },
    ]);
  });

  it('truncates a prompt at the broker limit rather than having it cut on arrival', () => {
    const record = createAuditRecord({ now: at(0) });
    record.addPrompt('x'.repeat(5000));
    expect(record.finish('completed').prompts[0].text).toHaveLength(4000);
  });

  it('caps prompts and actions at the broker limits', () => {
    const record = createAuditRecord({ now: at(0) });
    for (let i = 0; i < 250; i += 1) record.addPrompt(`p${i}`);
    for (let i = 0; i < 150; i += 1) record.addToolUse(`tool-${i}`);
    const finished = record.finish('completed');
    expect(finished.prompts).toHaveLength(200);
    expect(finished.actions).toHaveLength(100);
  });

  it('records the repository remote', () => {
    const record = createAuditRecord({ now: at(0) });
    record.setRepository('techflowasia/mittr-craft');
    expect(record.finish('completed').repository).toBe('techflowasia/mittr-craft');
  });

  it('records the model alias exactly as the catalog issued it', () => {
    const record = createAuditRecord({ now: at(0) });
    record.setModel('pm_9f2c1d4e7b');
    expect(record.finish('completed').model).toBe('pm_9f2c1d4e7b');
  });

  it('spans from the first event to the finish', () => {
    const record = createAuditRecord({ now: at(100, 400) });
    record.addTurn({ tokens: 1 });
    expect(record.finish('completed')).toMatchObject({ startedAt: 100, endedAt: 400 });
  });

  it('carries the outcome through', () => {
    expect(createAuditRecord({ now: at(0) }).finish('failed').outcome).toBe('failed');
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuditRecord } from './audit-record.js';

const at = (...times) => {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
};

test('turns and tokens are counted', () => {
  const record = createAuditRecord({ now: at(0) });
  record.addTurn({ tokens: 1200 });
  record.addTurn({ tokens: 800 });
  const finished = record.finish('completed');
  assert.equal(finished.turns, 2);
  assert.equal(finished.tokens, 2000);
});

test('tool uses are counted by name and keep no arguments', () => {
  const record = createAuditRecord({ now: at(0) });
  record.addToolUse('edit');
  record.addToolUse('edit');
  record.addToolUse('bash');
  assert.deepEqual(record.finish('completed').actions, [{ tool: 'edit', count: 2 }, { tool: 'bash', count: 1 }]);
});

test('typed instructions are kept in order with the time they arrived', () => {
  const record = createAuditRecord({ now: at(10, 20) });
  record.addPrompt('first thing');
  record.addPrompt('second thing');
  assert.deepEqual(record.finish('completed').prompts, [{ at: 10, text: 'first thing' }, { at: 20, text: 'second thing' }]);
});

test('a prompt is cut at the broker limit before it is sent', () => {
  const record = createAuditRecord({ now: at(0) });
  record.addPrompt('x'.repeat(5000));
  assert.equal(record.finish('completed').prompts[0].text.length, 4000);
});

test('prompts and actions stop at the broker limits, keeping the first ones', () => {
  const record = createAuditRecord({ now: at(0) });
  for (let i = 0; i < 250; i += 1) record.addPrompt(`p${i}`);
  for (let i = 0; i < 150; i += 1) record.addToolUse(`tool-${i}`);
  record.addToolUse('tool-0');
  const finished = record.finish('completed');
  assert.equal(finished.prompts.length, 200);
  assert.equal(finished.prompts.at(-1).text, 'p199');
  assert.equal(finished.actions.length, 100);
  assert.deepEqual(finished.actions[0], { tool: 'tool-0', count: 2 });
  assert.equal(finished.actions.at(-1).tool, 'tool-99');
});

test('the repository and the model alias are recorded as given', () => {
  const record = createAuditRecord({ now: at(0) });
  record.setRepository('techflowasia/mittr-craft');
  record.setModel('pm_9f2c1d4e7b');
  const finished = record.finish('completed');
  assert.equal(finished.repository, 'techflowasia/mittr-craft');
  assert.equal(finished.model, 'pm_9f2c1d4e7b');
});

test('a record spans from the first event to the finish', () => {
  const record = createAuditRecord({ now: at(100, 400) });
  record.addTurn({ tokens: 1 });
  const finished = record.finish('completed');
  assert.equal(finished.startedAt, 100);
  assert.equal(finished.endedAt, 400);
});

test('the outcome is carried through, and a record with no events still has a start', () => {
  const finished = createAuditRecord({ now: at(7) }).finish('failed');
  assert.equal(finished.outcome, 'failed');
  assert.equal(finished.startedAt, 7);
  assert.equal(finished.turns, 0);
  assert.deepEqual(finished.actions, []);
  assert.deepEqual(finished.prompts, []);
  assert.equal(finished.repository, null);
  assert.equal(finished.model, null);
});

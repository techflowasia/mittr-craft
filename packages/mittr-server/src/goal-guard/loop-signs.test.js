import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAILURE_MIN_CALLS,
  NOOP_EDIT_LIMIT,
  REPEAT_LIMIT,
  STALLED_TURN_LIMIT,
  loopSigns,
  summarizeTurn,
} from './loop-signs.js';
import { edit, failed, noopEdit, read, shell, step } from './test-records.js';

const JEST = 'npx jest apps/api/test/lead.spec.ts';
const failingJest = () => shell(JEST, 'FAIL apps/api/test/lead.spec.ts\nTests: 1 failed, 12 passed', 1);
const kinds = (signs) => signs.map((sign) => sign.kind);

const states = () => {
  let current = 0;
  return {
    same: () => ({ start: `tree${current}`, end: `tree${current}` }),
    next: () => ({ start: `tree${current}`, end: `tree${(current += 1)}` }),
    back: (to) => {
      const snapshot = { start: `tree${current}`, end: `tree${to}` };
      current = to;
      return snapshot;
    },
  };
};

test('a long healthy turn that runs the tests between real edits shows no sign', () => {
  const tree = states();
  const records = [];
  for (let round = 0; round < 20; round += 1) {
    records.push(step(read('apps/api/src/lead.ts'), tree.same()));
    records.push(step(edit('apps/api/src/lead.ts', `a${round}`, `a${round + 1}`), tree.next()));
    records.push(step(failingJest(), tree.same()));
    records.push(step(failingJest(), tree.same()));
  }

  const summary = summarizeTurn(records);

  assert.equal(summary.calls, 80);
  assert.equal(summary.repeat.count, 2);
  assert.equal(summary.changedFiles, true);
  assert.deepEqual(loopSigns(summary), []);
});

test('the same call three times with no file changed in between is a sign', () => {
  const tree = states();
  const records = [step(failingJest(), tree.same()), step(read('a.ts'), tree.same()), step(failingJest(), tree.same()), step(failingJest(), tree.same())];

  const summary = summarizeTurn(records);
  const signs = loopSigns(summary);

  assert.equal(REPEAT_LIMIT, 3);
  assert.deepEqual(summary.repeat, { count: 3, tool: 'shell', subject: JEST });
  assert.deepEqual(kinds(signs), ['repeat']);
  assert.equal(signs[0].reason, `same command "${JEST}" 3 times`);
});

test('a check whose answer changes each time is progress, not a repeat', () => {
  const answers = ['queued', 'in_progress (0/5 jobs)', 'in_progress (3/5 jobs)', 'completed: success'];
  const records = answers.map((answer) => step(shell('sleep 20 && gh run view 123', `run 123 ${answer}`), { start: 't0', end: 't0' }));

  const summary = summarizeTurn(records);

  assert.equal(summary.repeat, null);
  assert.deepEqual(loopSigns(summary), []);
});

test('a CI wait that keeps answering in_progress is no repeat, however often it runs', () => {
  const records = [];
  for (let index = 0; index < 12; index += 1) {
    records.push(step(shell('gh run watch 123 --exit-status=false; gh run view 123 --json status', '{"status":"in_progress"}', 0), { start: 't0', end: 't0' }));
  }

  const summary = summarizeTurn(records);

  assert.equal(summary.repeat, null);
  assert.deepEqual(loopSigns(summary), []);
});

test('the same call failing the same way counts, by exit code or by a failing test summary', () => {
  const byExit = [1, 2, 3].map(() => step(shell('curl -sf localhost:3000/health', 'curl: (22) The requested URL returned error: 503', 22), { start: 't0', end: 't0' }));
  const bySummary = [1, 2, 3].map(() => step(shell('bun test lead', '3 pass\n1 fail\nFAILED lead.test.ts'), { start: 't0', end: 't0' }));

  assert.deepEqual(kinds(loopSigns(summarizeTurn(byExit))), ['repeat']);
  assert.deepEqual(kinds(loopSigns(summarizeTurn(bySummary))), ['repeat']);
});

test('the same failure is a repeat although timings, dates and ids differ in its output', () => {
  const runs = [
    ['12 ms', '3.21 s', '2026-11-25T21:14:03.112Z', 'a3f9c2e71b'],
    ['9 ms', '2.98 s', '2026-11-25T21:19:44.020Z', '0be41d77c9'],
    ['15ms', '4.1s', '2026-11-25 21:31:10', 'c0ffee1234567'],
  ];
  const records = runs.map(([test, total, at, id]) => step(
    shell(JEST, `FAIL apps/api/test/lead.spec.ts\n  x keeps the shown text (${test})\nTime: ${total}\nat ${at} run ${id}\n`),
    { start: 't0', end: 't0' },
  ));

  const signs = loopSigns(summarizeTurn(records));

  assert.deepEqual(kinds(signs), ['repeat']);
});

test('edits that put files back to an earlier state do not count as progress between repeats', () => {
  const tree = states();
  const records = [
    step(failingJest(), tree.same()),
    step(edit('a.ts', 'x', 'y'), tree.next()),
    step(failingJest(), tree.same()),
    step(edit('a.ts', 'y', 'x'), tree.back(0)),
    step(failingJest(), tree.same()),
    step(edit('a.ts', 'x', 'y'), tree.back(1)),
    step(failingJest(), tree.same()),
  ];

  assert.equal(summarizeTurn(records).repeat.count, 3);
});

test('without snapshots a successful edit counts as the change between repeats', () => {
  const records = [step(failingJest()), step(edit('a.ts', 'x', 'y')), step(failingJest()), step(failingJest()), step(failed('edit', { path: 'a.ts', oldString: 'q', newString: 'r' })), step(failingJest())];

  const summary = summarizeTurn(records);

  assert.equal(summary.repeat.count, 3);
  assert.equal(summary.changedFiles, true);
});

test('edits whose old and new text are equal are a sign once there are enough of them', () => {
  const tree = states();
  const records = [];
  for (let index = 0; index < 40; index += 1) records.push(step(edit('a.ts', `v${index}`, `v${index + 1}`), tree.next()));
  for (let index = 0; index < NOOP_EDIT_LIMIT - 1; index += 1) records.push(step(noopEdit('a.ts', `same ${index}`), tree.same()));

  assert.deepEqual(loopSigns(summarizeTurn(records)), []);

  records.push(step(noopEdit('a.ts', 'one more'), tree.same()));
  const signs = loopSigns(summarizeTurn(records));
  assert.deepEqual(kinds(signs), ['noopEdits']);
  assert.equal(signs[0].reason, '5 edits changed nothing');
});

test('a few no-op edits among hundreds of real ones are no sign', () => {
  const tree = states();
  const records = [];
  for (let index = 0; index < 200; index += 1) records.push(step(edit('a.ts', `v${index}`, `v${index + 1}`), tree.next()));
  for (let index = 0; index < 6; index += 1) records.push(step(noopEdit('a.ts', `same ${index}`), tree.same()));

  assert.deepEqual(loopSigns(summarizeTurn(records)), []);
});

test('a high share of failed calls is a sign only over the minimum count', () => {
  const tree = states();
  const small = [];
  for (let index = 0; index < 5; index += 1) small.push(step(failed('read', { path: `missing${index}.ts` }), tree.same()));
  assert.deepEqual(loopSigns(summarizeTurn(small)), []);

  const large = [];
  for (let index = 0; index < FAILURE_MIN_CALLS - 4; index += 1) large.push(step(edit('a.ts', `v${index}`, `v${index + 1}`), tree.next()));
  for (let index = 0; index < 4; index += 1) large.push(step(failed('read', { path: `missing${index}.ts` }), tree.same()));
  const signs = loopSigns(summarizeTurn(large));
  assert.deepEqual(kinds(signs), ['failures']);
  assert.equal(signs[0].reason, '4 of 20 tool calls failed');
});

test('turns in a row without a changed file or a commit are a sign from the limit on', () => {
  const summary = summarizeTurn([step(read('a.ts'))]);

  assert.deepEqual(loopSigns(summary, { stalledTurns: STALLED_TURN_LIMIT - 1 }), []);
  const signs = loopSigns(summary, { stalledTurns: STALLED_TURN_LIMIT });
  assert.deepEqual(kinds(signs), ['stalled']);
  assert.equal(signs[0].reason, 'no file changed and no commit in 3 turns');
});

test('the measured turn of 25 Nov reads as a loop on more than one count', () => {
  const tree = states();
  const records = [];
  for (let round = 0; round < 16; round += 1) {
    records.push(step(edit('turn.service.ts', 'kept.text', 'kept'), tree.next()));
    records.push(step(edit('turn.service.ts', 'kept', 'kept.text'), tree.back(0)));
    records.push(step(noopEdit('turn.service.ts', 'if (text && end !== "length") return text;'), tree.same()));
    records.push(step(failingJest(), tree.same()));
    records.push(step(failed('edit', { command: 'git checkout -p' }), tree.same()));
  }

  const signs = loopSigns(summarizeTurn(records));

  assert.deepEqual(kinds(signs), ['repeat', 'noopEdits', 'failures']);
  assert.equal(signs[0].count, 16);
});

test('a turn with no tool calls has nothing to count', () => {
  const summary = summarizeTurn([{ id: 'msg_1', type: 'assistant', content: [{ type: 'text', text: 'Done.' }] }, { id: 'msg_2', type: 'compaction' }]);

  assert.deepEqual(summary, { calls: 0, failed: 0, edits: 0, noopEdits: 0, repeat: null, changedFiles: false });
  assert.deepEqual(loopSigns(summary), []);
});

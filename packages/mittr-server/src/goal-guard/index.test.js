import assert from 'node:assert/strict';
import test from 'node:test';

import { STALLED_TURN_LIMIT } from './loop-signs.js';
import { createGoalGuard } from './index.js';
import { edit, noopEdit, read, shell, step } from './test-records.js';

const SESSION = 'ses_1';
const input = (extra = {}) => ({ sessionId: SESSION, directory: '/repo', goalId: 'goal_1', resumed: false, ...extra });
const silent = { warn: () => {} };

const loopingTurn = (key) => {
  const records = [];
  for (let index = 0; index < 4; index += 1) records.push(step(shell('npx jest lead.spec.ts', 'FAIL lead.spec.ts\nTests: 1 failed', 1), { start: 't0', end: 't0' }));
  return { key, records };
};
const healthyTurn = (key, round = 0) => ({
  key,
  records: [
    step(read('lead.ts'), { start: `t${round}`, end: `t${round}` }),
    step(edit('lead.ts', `a${round}`, `a${round + 1}`), { start: `t${round}`, end: `t${round + 1}` }),
    step(shell('npx jest lead.spec.ts'), { start: `t${round + 1}`, end: `t${round + 1}` }),
  ],
});
const idleTurn = (key) => ({ key, records: [step(read('progress.md'))] });

const PERSON = 'Please also check the docs.';

const ciWaitTurn = (key) => ({
  key,
  records: Array.from({ length: 8 }, () => step(shell('gh run view 123 --json status', '{"status":"in_progress"}', 0), { start: 't0', end: 't0' })),
});

const guardWith = (turns, { probe = async () => null, logger = silent, sweep = async () => {}, remove = async () => {} } = {}) => {
  let index = 0;
  let sentNote = '';
  const readTurn = async () => {
    const { delivered = true, ...turn } = turns[Math.min(index++, turns.length - 1)];
    return { opener: delivered ? `The session goal is still open.\n\n${sentNote}\n\nWork autonomously.` : PERSON, ...turn };
  };
  const guard = createGoalGuard({ readTurn, probe, sweep, remove, logger });
  return {
    ended: guard.ended,
    review: async (asked) => {
      const answer = await guard.review(asked);
      sentNote = answer.note ?? '';
      return answer;
    },
  };
};

test('a normal turn continues with no note', async () => {
  const guard = guardWith([healthyTurn('msg_a')]);

  assert.deepEqual(await guard.review(input()), { note: '' });
});

test('the first looping turn gets a plain warning, the next one blocks the goal with a readable reason', async () => {
  const guard = guardWith([loopingTurn('msg_a'), loopingTurn('msg_b')]);

  const first = await guard.review(input());
  const second = await guard.review(input());

  assert.match(first.note, /ran the same command "npx jest lead\.spec\.ts" 4 times, failing the same way, with no file changed in between/);
  assert.match(first.note, /Change your approach/);
  assert.match(first.note, /stop and report/);
  assert.equal(first.block, undefined);
  assert.deepEqual(second, { block: 'looping: same command "npx jest lead.spec.ts" 4 times' });
});

test('a warning that never reached the agent does not count toward a block', async () => {
  const guard = guardWith([loopingTurn('msg_a'), { ...loopingTurn('msg_b'), delivered: false }, loopingTurn('msg_c')]);

  await guard.review(input());
  const undelivered = await guard.review(input());
  const delivered = await guard.review(input());

  assert.equal(undelivered.block, undefined);
  assert.match(undelivered.note, /Loop check/);
  assert.match(delivered.block, /^looping: same command "npx jest lead\.spec\.ts" 4 times/);
});

test('a good turn between two looping ones starts the count again', async () => {
  const guard = guardWith([loopingTurn('msg_a'), healthyTurn('msg_b'), loopingTurn('msg_c')]);

  await guard.review(input());
  await guard.review(input());
  const third = await guard.review(input());

  assert.equal(third.block, undefined);
  assert.match(third.note, /4 times/);
});

test('reviewing the same turn again does not count it twice', async () => {
  const guard = guardWith([loopingTurn('msg_a'), loopingTurn('msg_a')]);

  const first = await guard.review(input());
  const again = await guard.review(input());

  assert.deepEqual(again, first);
});

test('a resumed goal gets a fresh count and its old turn is not judged again', async () => {
  const guard = guardWith([loopingTurn('msg_a'), loopingTurn('msg_b'), loopingTurn('msg_b'), loopingTurn('msg_c')]);

  await guard.review(input());
  assert.ok((await guard.review(input())).block);
  assert.deepEqual(await guard.review(input({ resumed: true })), { note: '' });
  const afterResume = await guard.review(input());

  assert.equal(afterResume.block, undefined);
  assert.match(afterResume.note, /4 times/);
});

test('a new goal on the session starts from nothing', async () => {
  const guard = guardWith([loopingTurn('msg_a'), loopingTurn('msg_b')]);

  await guard.review(input());
  const other = await guard.review(input({ goalId: 'goal_2' }));

  assert.equal(other.block, undefined);
});

test('turns without a changed file or a new commit count up to a stall', async () => {
  const head = 'c1';
  const tree = 'tree1';
  const probe = async () => ({ head, tree, refs: [] });
  const turns = Array.from({ length: STALLED_TURN_LIMIT + 1 }, (_, index) => idleTurn(`msg_${index}`));
  const guard = guardWith(turns, { probe });

  const answers = [];
  for (let index = 0; index < turns.length; index += 1) answers.push(await guard.review(input()));

  assert.deepEqual(answers.slice(0, STALLED_TURN_LIMIT - 1), Array(STALLED_TURN_LIMIT - 1).fill({ note: '' }));
  assert.match(answers[STALLED_TURN_LIMIT - 1].note, /changed no file and committed nothing in 3 runs in a row/);
  assert.equal(answers[STALLED_TURN_LIMIT].block, undefined);
  assert.match(answers[STALLED_TURN_LIMIT].note, /4 runs in a row/);
});

test('a stall blocks only together with a repeat, no-op edit or failure sign', async () => {
  const probe = async () => ({ head: 'c1', tree: 'tree1', refs: [] });
  const turns = [idleTurn('msg_0'), idleTurn('msg_1'), idleTurn('msg_2'), loopingTurn('msg_3')];
  const guard = guardWith(turns, { probe });

  for (let index = 0; index < 3; index += 1) await guard.review(input());
  const answer = await guard.review(input());

  assert.equal(answer.block, 'looping: same command "npx jest lead.spec.ts" 4 times, no file changed and no commit in 4 turns');
});

test('a goal that waits on CI is never blocked, only reminded that nothing changed', async () => {
  const probe = async () => ({ head: 'c1', tree: 'tree1', refs: [] });
  const guard = guardWith(Array.from({ length: 8 }, (_, index) => ciWaitTurn(`msg_${index}`)), { probe });

  for (let index = 0; index < 8; index += 1) {
    const answer = await guard.review(input());
    assert.equal(answer.block, undefined);
    assert.doesNotMatch(answer.note, /ran the same/);
  }
});

test('a finished or cleared goal takes its checkpoints with it', async () => {
  const removed = [];
  const remove = async (directory, sessionId) => { removed.push([directory, sessionId]); };
  const guard = guardWith([healthyTurn('msg_a')], { remove });

  await guard.review(input({ directory: '/work/repo' }));
  await guard.ended({ sessionId: SESSION, directory: '', reason: 'complete' });
  await guard.ended({ sessionId: 'ses_unknown', directory: '', reason: 'cleared' });
  await guard.ended({ sessionId: 'ses_other', directory: '/other', reason: 'cleared' });

  assert.deepEqual(removed, [['/work/repo', SESSION], ['/other', 'ses_other']]);
});

test('old checkpoints are swept once per folder after the server starts', async () => {
  const swept = [];
  const guard = guardWith([healthyTurn('msg_a'), healthyTurn('msg_b', 1), healthyTurn('msg_c', 2)], { sweep: async (directory) => { swept.push(directory); } });

  await guard.review(input({ directory: '/one' }));
  await guard.review(input({ directory: '/one' }));
  await guard.review(input({ directory: '/two', sessionId: 'ses_2' }));

  assert.deepEqual(swept, ['/one', '/two']);
});

test('a new commit or a changed work tree is progress even when the turn shows no edit', async () => {
  const states = [
    { head: 'c1', tree: 'tree1' },
    { head: 'c2', tree: 'tree2' },
    { head: 'c2', tree: 'tree3' },
    { head: 'c2', tree: 'tree4' },
    { head: 'c3', tree: 'tree4' },
  ];
  let index = 0;
  const probe = async () => ({ ...states[index++], refs: [] });
  const guard = guardWith(states.map((_, at) => idleTurn(`msg_${at}`)), { probe });

  for (let turn = 0; turn < states.length; turn += 1) {
    assert.deepEqual(await guard.review(input()), { note: '' });
  }
});

test('every continuation names the newest checkpoints, even with no loop', async () => {
  const refs = ['refs/mittrcraft/goal/ses_1/2', 'refs/mittrcraft/goal/ses_1/1'];
  const probe = async (directory, sessionId) => {
    assert.equal(directory, '/repo');
    assert.equal(sessionId, SESSION);
    return { head: 'c1', tree: 'tree1', refs };
  };
  const guard = guardWith([healthyTurn('msg_a'), loopingTurn('msg_b')], { probe });

  const calm = await guard.review(input());
  const warned = await guard.review(input());

  assert.match(calm.note, /refs\/mittrcraft\/goal\/ses_1\/2, refs\/mittrcraft\/goal\/ses_1\/1/);
  assert.match(warned.note, /4 times[\s\S]*git stash apply/);
});

test('a failed turn read or checkpoint judges nothing and keeps the goal going', async () => {
  const warnings = [];
  const logger = { warn: (...args) => warnings.push(args.join(' ')) };
  const guard = createGoalGuard({
    readTurn: async () => { throw new Error('message list failed with 500'); },
    probe: async () => { throw new Error('git broke'); },
    logger,
  });

  assert.deepEqual(await guard.review(input()), { note: '' });
  assert.equal(warnings.length, 2);
});

test('a session without a directory gets no checkpoint', async () => {
  let probed = false;
  const guard = guardWith([healthyTurn('msg_a')], { probe: async () => { probed = true; return null; } });

  await guard.review(input({ directory: '' }));

  assert.equal(probed, false);
});

test('the block reason stays within what goal metadata keeps', async () => {
  const records = [];
  for (let index = 0; index < 30; index += 1) records.push(step(noopEdit('a-very-long-path/that/keeps/going/and/going/turn.service.ts', `same text ${index % 2}`), { start: 't0', end: 't0' }));
  const guard = guardWith([{ key: 'msg_a', records }, { key: 'msg_b', records }]);

  await guard.review(input());
  const { block } = await guard.review(input());

  assert.ok(block.startsWith('looping: same edit of a-very-long-path'));
  assert.ok(block.length <= 200);
});

test('a commit made while the turn could not be read still counts as progress on the next turn', async () => {
  const heads = ['c1', 'c1', 'c2', 'c2'];
  let at = 0;
  const probe = async () => ({ head: heads[at++], tree: 'tree1', refs: [] });
  const turns = [idleTurn('msg_0'), idleTurn('msg_1'), null, idleTurn('msg_3')];
  let index = 0;
  const readTurn = async () => {
    const turn = turns[index++];
    if (!turn) throw new Error('message list failed with 500');
    return turn;
  };
  const guard = createGoalGuard({ readTurn, probe, logger: silent });

  await guard.review(input());
  await guard.review(input());
  await guard.review(input());

  assert.deepEqual(await guard.review(input()), { note: '' });
});

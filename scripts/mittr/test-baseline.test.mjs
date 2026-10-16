import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { compareStage, parseFailures, rootTestStages, runTestBaseline } from './test-baseline.mjs';

const ISOLATED_OUTPUT = `FAIL (node) src/a.test.mjs
FAIL (bun) src/b.test.ts

===== src/a.test.mjs (node) =====
▶ outer
  ✖ inner fails (0.812916ms)
✖ outer (1.12575ms)
✔ plain passes (0.038792ms)
✖ plain fails > with arrow (0.038209ms)
ℹ fail 2

✖ failing tests:

test at src/a.test.mjs:2:38
✖ inner fails (0.812916ms)
  AssertionError [ERR_ASSERTION]: 1 == 2

test at src/a.test.mjs:4:1
✖ plain fails > with arrow (0.038209ms)
  Error: x


===== src/b.test.ts (bun) =====
bun test v1.3.14 (d1632b29)
error: expect(received).toBe(expected)
(fail) Suite one > bun fails [4.87ms]

 1 pass
 1 fail

===== src/c.test.ts (bun) =====
SyntaxError: nothing loads

UNKNOWN RUNNER src/d.test.js: imports neither bun:test nor node:test

0/4 test files passed, 3 failed, 1 with no known runner
`;

const VITEST_OUTPUT = ` RUN  v4.1.5 /work/packages/web
 ❯ server/lib/spaces/websocket.test.js (2 tests | 1 failed) 3ms
     × ends every socket when it is closed 3ms
\x1b[31m FAIL \x1b[39m server/lib/spaces/websocket.test.js > the WebSocket forwarder > ends every socket when it is closed
AssertionError: expected 1 to be 2
 FAIL  server/lib/other.test.js > a > b
`;

test('reads the stages from the root test script', () => {
  const stages = rootTestStages({
    scripts: { test: 'node scripts/run-isolated-tests.mjs scripts && bun run --cwd packages/sdk test && bun run --cwd packages/web test' },
  });
  assert.deepEqual(stages.map(({ name, cwd }) => [name, cwd]), [['scripts', '.'], ['sdk', 'packages/sdk'], ['web', 'packages/web']]);
});

test('names each failing node and bun test, and a file that fails without one', () => {
  assert.deepEqual(parseFailures(ISOLATED_OUTPUT), [
    { file: 'src/a.test.mjs', test: 'inner fails' },
    { file: 'src/a.test.mjs', test: 'plain fails > with arrow' },
    { file: 'src/b.test.ts', test: 'Suite one > bun fails' },
    { file: 'src/c.test.ts', test: null },
    { file: 'src/d.test.js', test: null },
  ]);
});

test('names each failing vitest test, colours or not', () => {
  assert.deepEqual(parseFailures(VITEST_OUTPUT), [
    { file: 'server/lib/spaces/websocket.test.js', test: 'the WebSocket forwarder > ends every socket when it is closed' },
    { file: 'server/lib/other.test.js', test: 'a > b' },
  ]);
});

test('only a failure outside the baseline counts; a listed one that passed is reported', () => {
  const baseline = [
    { stage: 'web', file: 'server/lib/spaces/websocket.test.js', test: 'the WebSocket forwarder > ends every socket when it is closed' },
    { stage: 'web', file: 'server/lib/x.test.js', test: 'x' },
    { stage: 'ui', file: 'server/lib/other.test.js', test: 'a > b' },
  ];
  const result = compareStage({ stage: 'web', status: 1, failures: parseFailures(VITEST_OUTPUT), baseline });

  assert.deepEqual(result.known.map(({ file }) => file), ['server/lib/spaces/websocket.test.js']);
  assert.deepEqual(result.unexpected, [{ file: 'server/lib/other.test.js', test: 'a > b' }]);
  assert.deepEqual(result.nowPassing.map(({ file }) => file), ['server/lib/x.test.js']);
});

test('a stage that fails without naming a test, or a file without a test name, is never covered', () => {
  const baseline = [{ stage: 's', file: 'src/c.test.ts', test: 'anything' }];
  assert.deepEqual(compareStage({ stage: 's', status: 1, failures: [], baseline }).unexpected, [{ file: null, test: null }]);
  assert.deepEqual(
    compareStage({ stage: 's', status: 1, failures: [{ file: 'src/c.test.ts', test: null }], baseline }).unexpected,
    [{ file: 'src/c.test.ts', test: null }],
  );
});

test('runs every stage even after one fails, and fails only on a new failure', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-baseline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    scripts: { test: 'node run.mjs scripts && bun run --cwd packages/web test && bun run --cwd packages/ui test' },
  }));
  fs.mkdirSync(path.join(dir, 'brand'));
  const baseline = { failures: [{ stage: 'web', file: 'server/lib/spaces/websocket.test.js', test: 'the WebSocket forwarder > ends every socket when it is closed' }] };
  fs.writeFileSync(path.join(dir, 'brand', 'test-baseline.json'), JSON.stringify(baseline));

  const outputs = {
    scripts: { status: 0, output: 'all good' },
    web: { status: 1, output: ' FAIL  server/lib/spaces/websocket.test.js > the WebSocket forwarder > ends every socket when it is closed\n' },
    ui: { status: 0, output: 'all good' },
  };
  const ran = [];
  const exec = ({ command }) => {
    const name = command.match(/--cwd packages\/(\S+)/)?.[1] ?? 'scripts';
    ran.push(name);
    return outputs[name];
  };

  assert.equal(runTestBaseline({ cwd: dir, exec, log: () => {} }).ok, true);
  assert.deepEqual(ran, ['scripts', 'web', 'ui']);

  outputs.ui = { status: 1, output: '===== src/new.test.ts (bun) =====\n(fail) brand new [1.00ms]\n' };
  ran.length = 0;
  const lines = [];
  const result = runTestBaseline({ cwd: dir, exec, log: (line) => lines.push(line) });
  assert.equal(result.ok, false);
  assert.deepEqual(ran, ['scripts', 'web', 'ui', 'ui']);
  assert.match(lines.join('\n'), /new failure: src\/new\.test\.ts > brand new/);

  assert.throws(() => runTestBaseline({ cwd: dir, only: ['nope'], exec, log: () => {} }), /no test stage named nope/);
});

test('a failure that does not come back when the stage runs again is reported as flaky, not fatal', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-baseline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'bun run --cwd packages/web test' } }));
  fs.mkdirSync(path.join(dir, 'brand'));
  fs.writeFileSync(path.join(dir, 'brand', 'test-baseline.json'), JSON.stringify({ failures: [] }));
  const runs = [
    { status: 1, output: ' FAIL  a.test.js > sometimes\n FAIL  b.test.js > always\n' },
    { status: 1, output: ' FAIL  b.test.js > always\n FAIL  c.test.js > other time\n' },
  ];
  const lines = [];
  const result = runTestBaseline({ cwd: dir, exec: () => runs.shift(), log: (line) => lines.push(line) });

  assert.equal(result.ok, false);
  assert.deepEqual(result.results[0].unexpected, [{ file: 'b.test.js', test: 'always' }]);
  assert.deepEqual(result.results[0].flaky.map(({ file }) => file), ['a.test.js', 'c.test.js']);
  assert.match(lines.join('\n'), /flaky \(failed in one of two runs\): a\.test\.js > sometimes/);

  runs.push({ status: 1, output: ' FAIL  a.test.js > sometimes\n' }, { status: 0, output: '' });
  assert.equal(runTestBaseline({ cwd: dir, exec: () => runs.shift(), log: () => {} }).ok, true);
});

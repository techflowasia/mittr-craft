#!/usr/bin/env node
/**
 * Runs upstream's test suite one stage at a time and fails only on a failure
 * that `brand/test-baseline.json` does not list.
 *
 *   node scripts/mittr/test-baseline.mjs [<stage> ...] [--help]
 *
 * The stages are the `&&` parts of the root `test` script, read on every run so
 * a stage upstream adds is run too. Unlike `bun run test`, a failing stage does
 * not stop the next one. Each failing test is named by its stage, its file
 * (relative to the folder the stage runs in) and its name, read from the
 * output of the isolated runner (node and bun files) and of vitest.
 *
 * A failure the baseline lists passes; a listed failure that did not happen is
 * reported so the baseline can be trimmed, and is not an error. A stage that
 * fails without naming a test is an error.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BASELINE_FILE = 'brand/test-baseline.json';

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** The root test script split into stages, each named by its package or its last argument. */
export const rootTestStages = (rootManifest) => {
  const script = rootManifest.scripts?.test;
  if (!script) throw new Error('the root package.json has no test script');
  return script.split('&&').map((part) => part.trim()).filter(Boolean).map((command) => {
    const cwd = command.match(/--cwd\s+(\S+)/)?.[1] ?? '.';
    const name = cwd === '.' ? command.split(/\s+/).at(-1) : path.basename(cwd);
    return { name, command, cwd };
  });
};

const nodeFailures = (block) => {
  const marker = block.indexOf('✖ failing tests:');
  if (marker === -1) return [];
  return [...block.slice(marker).matchAll(/^✖ (.+?) \([\d.]+m?s\)$/gm)].map((match) => match[1]);
};

const bunFailures = (block) => [...block.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map((match) => match[1]);

/** `{ file, test }` for each failure the output names; `test` is null when only the file is known. */
export const parseFailures = (rawOutput) => {
  const output = rawOutput.replace(ANSI, '').replace(/\r/g, '');
  const failures = [];

  const blocks = output.split(/^===== (.+) \((node|bun)\) =====$/m);
  for (let index = 1; index + 2 <= blocks.length; index += 3) {
    const [file, runner, block] = [blocks[index], blocks[index + 1], blocks[index + 2] ?? ''];
    const names = runner === 'node' ? nodeFailures(block) : bunFailures(block);
    if (names.length === 0 || /\[killed after \d+s\]/.test(block)) failures.push({ file, test: null });
    for (const test of names) failures.push({ file, test });
  }
  for (const match of output.matchAll(/^UNKNOWN RUNNER (.+?): /gm)) failures.push({ file: match[1], test: null });

  for (const match of output.matchAll(/^ FAIL {1,2}(\S+)(?: > (.+?))?\s*$/gm)) {
    failures.push({ file: match[1], test: match[2] ?? null });
  }

  const seen = new Set();
  return failures.filter(({ file, test }) => {
    const key = `${file}\0${test}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const same = (left, right) => left.replace(/\s+/g, ' ').trim() === right.replace(/\s+/g, ' ').trim();

/**
 * Sorts one stage's failures against the baseline: `known` and `unexpected`
 * failures, and the baseline entries for this stage that did not fail.
 */
export const compareStage = ({ stage, status, failures, baseline }) => {
  const listed = baseline.filter((entry) => entry.stage === stage);
  const known = [];
  const unexpected = [];
  const matched = new Set();
  for (const failure of failures) {
    const entry = failure.test === null
      ? undefined
      : listed.find((candidate) => candidate.file === failure.file && same(candidate.test, failure.test));
    if (entry) {
      known.push(failure);
      matched.add(entry);
    } else {
      unexpected.push(failure);
    }
  }
  if (status !== 0 && failures.length === 0) unexpected.push({ file: null, test: null });
  return { stage, known, unexpected, nowPassing: listed.filter((entry) => !matched.has(entry)) };
};

const describe = ({ file, test }) => (file === null ? 'the stage failed without naming a test' : `${file}${test ? ` > ${test}` : ' (no test named)'}`);

export const formatBaselineReport = (results) => {
  const lines = [];
  for (const { stage, known, unexpected, nowPassing } of results) {
    const state = unexpected.length > 0 ? 'FAIL' : 'ok';
    lines.push(`[mittr] tests ${stage}: ${state} (${known.length} known failure(s), ${unexpected.length} new)`);
    for (const failure of unexpected) lines.push(`  new failure: ${describe(failure)}`);
    for (const entry of nowPassing) lines.push(`  baseline entry did not fail this run (trim it from ${BASELINE_FILE} if it stays green): ${entry.file} > ${entry.test}`);
  }
  const ok = results.every(({ unexpected }) => unexpected.length === 0);
  lines.push(ok ? '[mittr] no test failure outside the baseline' : '[mittr] test failures outside the baseline');
  return lines.join('\n');
};

const defaultExec = ({ command, cwd }) => {
  const result = spawnSync('/bin/sh', ['-c', command], { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

/** Runs the stages (all, or the ones named) and returns `{ ok, results }`. */
export const runTestBaseline = ({ cwd, only = [], exec = defaultExec, log = console.log }) => {
  const stages = rootTestStages(JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')));
  const unknown = only.filter((name) => !stages.some((stage) => stage.name === name));
  if (unknown.length > 0) throw new Error(`no test stage named ${unknown.join(', ')}; stages: ${stages.map(({ name }) => name).join(', ')}`);
  const { failures: baseline } = JSON.parse(fs.readFileSync(path.join(cwd, BASELINE_FILE), 'utf8'));

  const results = [];
  for (const stage of stages.filter(({ name }) => only.length === 0 || only.includes(name))) {
    log(`\n[mittr] tests ${stage.name}: ${stage.command}`);
    const { status, output } = exec({ command: stage.command, cwd });
    log(output.trimEnd());
    results.push(compareStage({ stage: stage.name, status, failures: status === 0 ? [] : parseFailures(output), baseline }));
  }
  log(`\n${formatBaselineReport(results)}`);
  return { ok: results.every(({ unexpected }) => unexpected.length === 0), results };
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/mittr/test-baseline.mjs [<stage> ...]\n\nRuns each stage of the root test script and fails only on a failure brand/test-baseline.json does not list.');
    process.exit(0);
  }
  const flag = args.find((arg) => arg.startsWith('-'));
  if (flag) {
    console.error(`[mittr] unknown option ${flag}`);
    process.exit(1);
  }
  try {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    process.exitCode = runTestBaseline({ cwd: repoRoot, only: args }).ok ? 0 : 1;
  } catch (error) {
    console.error(`[mittr] ${error.message}`);
    process.exitCode = 1;
  }
}

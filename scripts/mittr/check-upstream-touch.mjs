#!/usr/bin/env node
/**
 * Lists every upstream file that differs from the upstream commit in
 * `brand/UPSTREAM` and holds the line on how many there are.
 *
 *   node scripts/mittr/check-upstream-touch.mjs [--no-write]
 *
 * Paths we own are `packages/mittr-*`, `brand`, `scripts/mittr`, `patches` and
 * `docs`, except files upstream itself has there. Everything else is upstream.
 * Of the upstream files we touched:
 * - edited (or deleted) source and config files count toward the cap of 24,
 *   `bun.lock` included, which is never hand-merged but re-resolved with
 *   `bun install`;
 * - new upstream-side files are generic hook modules: listed, reviewed as
 *   hooks, not counted;
 * - test files that accompany a hook are listed and not counted.
 *
 * Every commit since the base that touches an upstream file must have a
 * `hook(<name>): ` subject, except one that touches only `bun.lock`. Merge
 * commits are skipped: they bring upstream in. A commit that broke the rule
 * before this check existed is listed in `ACKNOWLEDGED_COMMITS` with why,
 * reported on every run and not rewritten.
 *
 * Unless `--no-write`, it writes `patches/upstream/<path with / as __>.patch`
 * for each touched upstream file except the lockfile, a readable record that
 * nothing applies, and removes patches for files no longer touched.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const UPSTREAM_TOUCH_CAP = 24;

const OWNED_PREFIXES = ['brand/', 'scripts/mittr/', 'patches/', 'docs/'];
const OWNED_PACKAGE = /^packages\/mittr-[^/]+\//;
const LOCKFILES = new Set(['bun.lock']);
const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const HOOK_SUBJECT = /^hook\([^)]+\): /;
const PATCH_DIR = 'patches/upstream';

export const ACKNOWLEDGED_COMMITS = {
  a25bb133c7120a6104af91ac1d1d082fc532f22a:
    'widened the packages/mittr-ui block that hook(knip) 4075f0a0e added to knip.json, inside a fix(mittr-ui) commit made before this check existed',
};

const isOwned = (file) => OWNED_PACKAGE.test(file) || OWNED_PREFIXES.some((prefix) => file.startsWith(prefix));

export const patchFileName = (file) => `${file.replaceAll('/', '__')}.patch`;

const gitIn = (cwd) => (...args) => execFileSync(
  'git',
  ['-c', 'core.quotepath=off', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', ...args],
  { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
);

const nulFields = (output) => output.split('\0').filter((field) => field !== '');

const readBase = (cwd, git) => {
  const recorded = fs.readFileSync(path.join(cwd, 'brand', 'UPSTREAM'), 'utf8').trim();
  return git('rev-parse', '--verify', `${recorded}^{commit}`).trim();
};

const touchedSinceBase = (git, base, isUpstream) => {
  const fields = nulFields(git('diff', '--name-status', '-z', '--no-renames', base, 'HEAD'));
  const changes = [];
  for (let index = 0; index < fields.length; index += 2) {
    const [status, file] = [fields[index], fields[index + 1]];
    if (isUpstream(file)) changes.push({ status, file });
  }
  return changes;
};

const commitsSinceBase = (git, base, isUpstream) => {
  const log = git('log', '--no-merges', '--reverse', '-z', '--format=%H%x1f%s', `${base}..HEAD`);
  return nulFields(log).map((record) => {
    const [commit, subject] = record.split('\x1f');
    const files = nulFields(git('diff-tree', '--root', '--no-commit-id', '--no-renames', '--name-only', '-r', '-z', commit))
      .filter(isUpstream);
    return { commit, subject, files };
  });
};

const writePatches = ({ cwd, git, base, files }) => {
  const dir = path.join(cwd, PATCH_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const wanted = new Map(files.map((file) => [patchFileName(file), file]));
  for (const [name, file] of wanted) {
    fs.writeFileSync(path.join(dir, name), git('diff', '--no-color', '--no-ext-diff', '--no-renames', base, 'HEAD', '--', file));
  }
  const removed = fs.readdirSync(dir).filter((name) => name.endsWith('.patch') && !wanted.has(name)).sort();
  for (const name of removed) fs.rmSync(path.join(dir, name));
  return { written: [...wanted.keys()].sort(), removed };
};

export const checkUpstreamTouch = ({
  cwd = process.cwd(),
  write = true,
  cap = UPSTREAM_TOUCH_CAP,
  acknowledged = ACKNOWLEDGED_COMMITS,
} = {}) => {
  const git = gitIn(cwd);
  const base = readBase(cwd, git);
  const inBase = new Set(nulFields(git('ls-tree', '-r', '-z', '--name-only', base)));
  const isUpstream = (file) => inBase.has(file) || !isOwned(file);

  const counted = [];
  const added = [];
  const tests = [];
  const touched = touchedSinceBase(git, base, isUpstream);
  for (const { status, file } of touched) {
    if (LOCKFILES.has(file)) counted.push(file);
    else if (TEST_FILE.test(file)) tests.push(file);
    else if (status === 'A') added.push(file);
    else counted.push(file);
  }

  const violations = [];
  const acknowledgedCommits = [];
  for (const { commit, subject, files } of commitsSinceBase(git, base, isUpstream)) {
    if (files.length === 0 || files.every((file) => LOCKFILES.has(file)) || HOOK_SUBJECT.test(subject)) continue;
    if (Object.hasOwn(acknowledged, commit)) acknowledgedCommits.push({ commit, subject, files, reason: acknowledged[commit] });
    else violations.push({ commit, subject, files });
  }

  const patches = write
    ? writePatches({ cwd, git, base, files: touched.map(({ file }) => file).filter((file) => !LOCKFILES.has(file)) })
    : null;

  return {
    base,
    baseSubject: git('log', '-1', '--format=%s', base).trim(),
    cap,
    counted: counted.sort(),
    added: added.sort(),
    tests: tests.sort(),
    violations,
    acknowledged: acknowledgedCommits,
    patches,
    ok: counted.length <= cap && violations.length === 0,
  };
};

const short = (commit) => commit.slice(0, 9);
const list = (items) => items.map((item) => `  ${item}`).join('\n');

export const formatTouchReport = (result) => {
  const overCap = result.counted.length > result.cap;
  const lines = [
    `[mittr] upstream base ${short(result.base)} (${result.baseSubject})`,
    `[mittr] upstream files touched: ${result.counted.length} of ${result.cap}${overCap ? ' — over the cap; bring the reason to the owner' : ''}`,
    list(result.counted.map((file) => (LOCKFILES.has(file) ? `${file} (re-resolve with \`bun install\` on merge, never hand-merge)` : file))),
    `[mittr] new upstream-side hook files, reviewed as hooks and not counted: ${result.added.length}`,
    list(result.added),
    `[mittr] upstream test files that accompany hooks, not counted: ${result.tests.length}`,
    list(result.tests),
  ];
  if (result.acknowledged.length > 0) {
    lines.push(`[mittr] acknowledged non-hook commits, reviewed and not rewritten: ${result.acknowledged.length}`);
    lines.push(list(result.acknowledged.map(({ commit, subject, files, reason }) => `${short(commit)} ${subject} [${files.join(', ')}]: ${reason}`)));
  }
  if (result.violations.length === 0) {
    lines.push(`[mittr] every ${result.acknowledged.length > 0 ? 'other ' : ''}commit that touches an upstream file is a hook( commit`);
  } else {
    lines.push(`[mittr] commits that touch upstream files without a hook( subject: ${result.violations.length}`);
    lines.push(list(result.violations.map(({ commit, subject, files }) => `${short(commit)} ${subject} [${files.join(', ')}]`)));
  }
  if (result.patches) {
    lines.push(`[mittr] patches: ${result.patches.written.length} in ${PATCH_DIR}${result.patches.removed.length > 0 ? `, removed ${result.patches.removed.join(', ')}` : ''}`);
  }
  lines.push(result.ok ? '[mittr] upstream touch check passed' : '[mittr] upstream touch check FAILED');
  return lines.filter((line) => line !== '').join('\n');
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const result = checkUpstreamTouch({ cwd: repoRoot, write: !process.argv.includes('--no-write') });
    console.log(formatTouchReport(result));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(`[mittr] ${error.message}`);
    process.exitCode = 1;
  }
}

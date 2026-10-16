#!/usr/bin/env node
/**
 * Lists every upstream file that differs from the upstream commit in
 * `brand/UPSTREAM` and holds the line on how many there are.
 *
 *   node scripts/mittr/check-upstream-touch.mjs [--no-write] [--help]
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
 * commits are skipped: they bring upstream in. Only commits that descend from
 * the base count (`--ancestry-path`): when develop adopts this line with a
 * merge whose tree is ours, the 1.x history on its other side is not ours to
 * check, and commits made before the last upstream merge were checked when
 * they were made. A commit that broke the rule before this check existed is
 * listed in `ACKNOWLEDGED_COMMITS` with why, reported on every run and not
 * rewritten.
 *
 * Unless `--no-write`, it writes `patches/upstream/<upstream path>.patch` for
 * each touched upstream file except the lockfile, mirroring the tree so a
 * patch name maps back to exactly one path. It is a readable record that
 * nothing applies; patches for files no longer touched are removed.
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

const PATCH_SUFFIX = '.patch';

/** Where a file's patch lives under `patches/upstream`, and back. */
export const patchPathFor = (file) => `${file}${PATCH_SUFFIX}`;
export const upstreamPathOf = (patchPath) => patchPath.slice(0, -PATCH_SUFFIX.length);

/**
 * The patch paths for `files`. Mirroring cannot map two paths to one patch,
 * but a patch file could sit where another patch needs a folder (upstream
 * files `x` and `x.patch/y`); that is refused rather than overwritten.
 */
export const patchPathsFor = (files) => {
  const paths = files.map(patchPathFor);
  const taken = new Set(paths);
  for (const patchPath of paths) {
    const parts = patchPath.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      const folder = parts.slice(0, depth).join('/');
      if (taken.has(folder)) throw new Error(`patch ${folder} would have to be a folder for ${patchPath}`);
    }
  }
  return paths;
};

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
  const log = git('log', '--no-merges', '--ancestry-path', '--reverse', '-z', '--format=%H%x1f%s', `${base}..HEAD`);
  return nulFields(log).map((record) => {
    const [commit, subject] = record.split('\x1f');
    const files = nulFields(git('diff-tree', '--root', '--no-commit-id', '--no-renames', '--name-only', '-r', '-z', commit))
      .filter(isUpstream);
    return { commit, subject, files };
  });
};

const removeEmptyFolders = (dir, root) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyFolders(path.join(dir, entry.name), root);
  }
  if (dir !== root && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
};

const writePatches = ({ cwd, git, base, files }) => {
  const dir = path.join(cwd, PATCH_DIR);
  const wanted = new Set(patchPathsFor(files));
  fs.mkdirSync(dir, { recursive: true });
  const removed = fs.readdirSync(dir, { recursive: true })
    .map((entry) => entry.split(path.sep).join('/'))
    .filter((entry) => entry.endsWith(PATCH_SUFFIX) && !wanted.has(entry) && fs.statSync(path.join(dir, entry)).isFile())
    .sort();
  for (const entry of removed) fs.rmSync(path.join(dir, entry));
  removeEmptyFolders(dir, dir);
  for (const patchPath of wanted) {
    const target = path.join(dir, patchPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, git('diff', '--no-color', '--no-ext-diff', '--no-renames', base, 'HEAD', '--', upstreamPathOf(patchPath)));
  }
  return { written: [...wanted].sort(), removed };
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

const USAGE = `Usage: node scripts/mittr/check-upstream-touch.mjs [--no-write] [--help]

Lists the upstream files that differ from brand/UPSTREAM, fails above ${UPSTREAM_TOUCH_CAP}
or on a commit that touches one without a hook( subject, and writes
patches/upstream/<path>.patch for each (not with --no-write).`;

/** Only the options this command knows; anything else is an error, never ignored. */
export const parseTouchArgs = (argv) => {
  const options = { write: true, help: false };
  for (const arg of argv) {
    const name = arg.split('=')[0];
    if (!arg.startsWith('-')) throw new Error(`takes no arguments, got ${arg}`);
    if (name !== '--no-write' && name !== '--help' && name !== '-h') throw new Error(`unknown option ${name}`);
    if (arg.includes('=')) throw new Error(`${name} takes no value`);
    if (name === '--no-write') options.write = false;
    else options.help = true;
  }
  return options;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const options = parseTouchArgs(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE);
      process.exit(0);
    }
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const result = checkUpstreamTouch({ cwd: repoRoot, write: options.write });
    console.log(formatTouchReport(result));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(`[mittr] ${error.message}`);
    process.exitCode = 1;
  }
}

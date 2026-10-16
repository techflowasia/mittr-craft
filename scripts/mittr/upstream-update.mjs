#!/usr/bin/env node
/**
 * Brings an upstream OpenChamber commit into MittrCraft on a side branch and
 * runs every check that says whether the result still works.
 *
 *   node scripts/mittr/upstream-update.mjs <upstream-commit> [--from develop] [--remote origin] [--no-fetch]
 *   node scripts/mittr/upstream-update.mjs <upstream-commit> --dry-run
 *   node scripts/mittr/upstream-update.mjs <upstream-commit> --continue
 *   node scripts/mittr/upstream-update.mjs --help
 *
 * Options also take the `--from=<branch>` form. An option it does not know is
 * an error, so a mistyped `--dry-run` can never start a real run.
 *
 * `--from` must be a branch on the upstream-based line, one that carries
 * `brand/UPSTREAM`. Until phase 5, develop has no `brand/UPSTREAM` (it is still
 * the 1.x line), so pass `--from rebase/upstream-2.1.1`.
 *
 * Upstream is mirrored as `<remote>/main`; release commits read "release vX.Y.Z".
 * The steps:
 * 1. fetch, then create `upstream-update/<short-sha>` from `--from` (develop);
 * 2. merge the upstream commit with rerere on, as a plain merge. On a conflict
 *    it stops and, for each conflicted file, prints the hook commits that own
 *    it with the reason from each one's body;
 * 3. record the commit in `brand/UPSTREAM`, run the upstream touch check and
 *    commit the base and its patches;
 * 4. `bun install` (committing a re-resolved `bun.lock`), the upstream
 *    contract tests, then the root type-check and lint, upstream's tests one
 *    stage at a time against the recorded baseline (`test-baseline.mjs`,
 *    which fails only on a failure `brand/test-baseline.json` does not list),
 *    and our own package and `scripts/mittr` tests, which the root tests do
 *    not run;
 * 5. the visible-string check, then the Dev build, which ends with the
 *    brand-leak scan of the packed app;
 * 6. a summary with the upstream touch count and the walk checklist.
 *
 * It stops at the first failure and says what to do next. After fixing and
 * committing on the update branch, `--continue` runs again from step 3. It
 * never pushes, never commits to `--from` or main, and never merges with
 * `-X ours` or `-X theirs`.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveBunExecutable } from '../lib/bun-executable.mjs';
import { checkUpstreamTouch, formatTouchReport } from './check-upstream-touch.mjs';

const BRANCH_PREFIX = 'upstream-update/';
const REBASED_LINE = 'rebase/upstream-2.1.1';
const NO_BASE_HINT = `until phase 5, develop has no brand/UPSTREAM; pass --from ${REBASED_LINE}`;
const LOCKFILE = 'bun.lock';
const HOOK_SUBJECT = /^hook\([^)]+\): /;

class Stop extends Error {
  constructor(step, message, next) {
    super(message);
    this.step = step;
    this.next = next;
  }
}

const gitIn = (cwd) => {
  const git = (...args) => execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
  git.ok = (...args) => {
    try {
      git(...args);
      return true;
    } catch {
      return false;
    }
  };
  return git;
};

const defaultRun = ({ command, args, cwd }) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

const firstParagraph = (body) => body.trim().split(/\n\s*\n/)[0]?.replace(/\s*\n\s*/g, ' ') ?? '';

/**
 * Our commits since the old base that touched `file`, hooks first, each with
 * the reason in its body. Only commits that descend from the base: the 1.x
 * history develop's adoption merge keeps reachable is not ours on this line.
 */
const ownersOf = (git, oldBase, file) => {
  const log = git('log', '--no-merges', '--ancestry-path', '--format=%H%x1f%s%x1f%b%x1e', `${oldBase}..HEAD`, '--', file);
  const commits = log.split('\x1e').map((record) => record.trim()).filter(Boolean).map((record) => {
    const [commit, subject, body = ''] = record.split('\x1f');
    return { commit, subject, reason: firstParagraph(body) };
  });
  return [...commits.filter(({ subject }) => HOOK_SUBJECT.test(subject)), ...commits.filter(({ subject }) => !HOOK_SUBJECT.test(subject))];
};

const describeConflicts = (git, oldBase, files) => {
  const remaining = new Set(git('rerere', 'remaining').split('\n').filter(Boolean));
  return files.map((file) => {
    const lines = [`  ${file}${remaining.has(file) ? '' : ' (rerere replayed a recorded resolution: review it, then git add)'}`];
    if (file === LOCKFILE) {
      lines.push('    never hand-merge: take upstream\'s and re-resolve with `git checkout MERGE_HEAD -- bun.lock && bun install && git add bun.lock`');
      return lines.join('\n');
    }
    const owners = ownersOf(git, oldBase, file);
    if (owners.length === 0) lines.push('    no commit of ours since the last base touched this file');
    for (const { commit, subject, reason } of owners) {
      lines.push(`    ${commit.slice(0, 9)} ${subject}`);
      if (reason) lines.push(`      why: ${reason}`);
    }
    return lines.join('\n');
  }).join('\n');
};

const mittrTestPackages = (cwd) => {
  const packagesDir = path.join(cwd, 'packages');
  if (!fs.existsSync(packagesDir)) return [];
  return fs.readdirSync(packagesDir)
    .filter((name) => name.startsWith('mittr-'))
    .filter((name) => {
      const manifest = path.join(packagesDir, name, 'package.json');
      return fs.existsSync(manifest) && Boolean(JSON.parse(fs.readFileSync(manifest, 'utf8')).scripts?.test);
    })
    .sort();
};

const WALK_CHECKLIST = [
  'Open the Dev build with a temporary HOME holding a copy of real 1.22 data: same session count before and after, open three old sessions, every account still there.',
  'Walk every sidebar item, every Settings page and every exit (switch account, sign out, quit and reopen), and open a second window.',
  'About shows the expected version and no update check; the brand-leak scan at the end of the build is clean.',
  'Only then ask the owner before pushing the update branch and opening its pull request into develop.',
];

/**
 * The update as a list of steps. Each has the commands a dry run prints and
 * the code a real run executes, so the plan and the run cannot drift apart.
 */
const buildSteps = (ctx) => {
  const { cwd, git, run, log, bun, node, sha, short, branch, from } = ctx;
  const gate = (step, command, args, label = [path.basename(command), ...args].join(' ')) => ({
    show: label,
    exec: () => {
      log(`\n[mittr] ${label}`);
      if (run({ command, args, cwd }) !== 0) {
        throw new Stop(step, `${label} failed`, 'fix it on this branch and commit');
      }
    },
  });

  const commitIfStaged = (message) => {
    if (!git.ok('diff', '--cached', '--quiet')) git('commit', '-q', '-m', message);
  };

  return [
    {
      id: 'branch',
      title: `1. branch ${branch} from ${from}`,
      skipOnResume: true,
      commands: [
        { show: 'git config rerere.enabled true (if it is not on)', exec: () => {
          if (git.ok('config', '--get', 'rerere.enabled') && git('config', '--get', 'rerere.enabled') === 'true') return;
          git('config', 'rerere.enabled', 'true');
          log('[mittr] turned on rerere for this repository, so conflict resolutions are replayed next time');
        } },
        { show: `git switch -c ${branch} ${from}`, exec: () => git('switch', '-q', '-c', branch, from) },
      ],
    },
    {
      id: 'merge',
      title: `2. merge upstream ${short}`,
      skipOnResume: true,
      commands: [{
        show: `git merge --no-ff --no-edit -m "chore(upstream): merge <subject> (${short})" ${short}`,
        exec: () => {
          const oldBase = git('show', 'HEAD:brand/UPSTREAM');
          const subject = git('log', '-1', '--format=%s', sha);
          try {
            git('merge', '--no-ff', '--no-edit', '-m', `chore(upstream): merge ${subject} (${short})`, sha);
          } catch (error) {
            const conflicted = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
            if (conflicted.length === 0) throw new Stop('merge', `git merge failed: ${error.stderr || error.message}`, 'see git status');
            throw new Stop(
              'merge',
              `the merge of ${short} conflicts in ${conflicted.length} file(s):\n${describeConflicts(git, oldBase, conflicted)}`,
              'resolve each file by hand, keeping the hook and the reason above, then git add and git commit',
            );
          }
        },
      }],
    },
    {
      id: 'record',
      title: '3. record the base and check the upstream touch',
      commands: [{
        show: `write ${sha} to brand/UPSTREAM; node scripts/mittr/check-upstream-touch.mjs; commit "chore(brand): record upstream base ${short}"`,
        exec: () => {
          fs.writeFileSync(path.join(cwd, 'brand', 'UPSTREAM'), `${sha}\n`);
          const touch = checkUpstreamTouch({ cwd });
          ctx.touch = touch;
          log(formatTouchReport(touch));
          git('add', '--', 'brand/UPSTREAM', 'patches/upstream');
          commitIfStaged(`chore(brand): record upstream base ${short}`);
          if (!touch.ok) {
            throw new Stop('record', 'the upstream touch check failed', 'bring the files over the cap, or the non-hook commits, to the owner before going on');
          }
        },
      }],
    },
    {
      id: 'checks',
      title: '4. install, contract tests, type-check, lint and tests',
      commands: [
        {
          show: `${path.basename(bun)} install (commit a re-resolved bun.lock)`,
          exec: () => {
            gate('checks', bun, ['install']).exec();
            git('add', '--', LOCKFILE);
            commitIfStaged(`chore(deps): re-resolve bun.lock for upstream ${short}`);
          },
        },
        gate('checks', node, ['--test', 'packages/mittr-server/src/upstream-contract.test.js']),
        gate('checks', bun, ['run', 'type-check']),
        gate('checks', bun, ['run', 'lint']),
        gate('checks', node, ['scripts/mittr/test-baseline.mjs']),
        ...mittrTestPackages(cwd).map((name) => gate('checks', bun, ['run', '--cwd', `packages/${name}`, 'test'])),
        gate('checks', node, ['scripts/run-isolated-tests.mjs', 'scripts/mittr']),
      ],
    },
    {
      id: 'build',
      title: '5. visible strings, then the Dev build and its brand-leak scan',
      commands: [
        gate('build', node, ['scripts/mittr/build-desktop.mjs', '--check-strings', '--flavor', 'dev']),
        gate('build', node, ['scripts/mittr/build-desktop.mjs', '--flavor', 'dev']),
      ],
    },
  ];
};

const summary = (ctx, outcome) => {
  const lines = ['', '[mittr] upstream update summary'];
  lines.push(`  upstream: ${ctx.short ?? ctx.commit}${ctx.branch ? ` on ${ctx.branch}` : ''}`);
  let touch = ctx.touch;
  let when = '';
  if (!touch) {
    try {
      touch = checkUpstreamTouch({ cwd: ctx.cwd, write: false });
      when = ' before this merge';
    } catch {
      touch = null;
    }
  }
  lines.push(touch
    ? `  upstream files touched${when}: ${touch.counted.length} of ${touch.cap} (plus ${touch.added.length} new hook files and ${touch.tests.length} test files, not counted)`
    : '  upstream files touched: could not be counted');
  lines.push(`  ${outcome}`);
  return lines.join('\n');
};

/**
 * Runs (or with `dryRun`, prints) the update. Returns `{ status }`, one of
 * `planned`, `done` or `stopped` (with `step`); `run` executes every non-git
 * command and returns its exit code.
 */
export const runUpstreamUpdate = ({
  cwd = process.cwd(),
  commit,
  from = 'develop',
  remote = 'origin',
  fetch = true,
  dryRun = false,
  resume = false,
  run = defaultRun,
  log = console.log,
  bun = resolveBunExecutable(),
  node = process.execPath,
}) => {
  const git = gitIn(cwd);
  const ctx = { cwd, git, run, log, bun, node, commit, from, remote, fetch };
  try {
    if (!commit) throw new Stop('start', 'no upstream commit given', 'pass one, e.g. origin/main or a "release vX.Y.Z" commit');

    const resolve = () => {
      ctx.sha = git('rev-parse', '--verify', `${commit}^{commit}`);
      ctx.short = git('rev-parse', '--short=9', ctx.sha);
      ctx.branch = `${BRANCH_PREFIX}${ctx.short}`;
    };

    if (dryRun) {
      if (git.ok('rev-parse', '--verify', `${commit}^{commit}`)) resolve();
      else Object.assign(ctx, { sha: commit, short: commit, branch: `${BRANCH_PREFIX}<short-sha>` });
      log(`[mittr] dry run: the plan for upstream ${ctx.short}; nothing below runs now`);
      if (fetch) log(`0. git fetch ${remote}, then resolve ${commit}`);
      if (!git.ok('cat-file', '-e', `${from}:brand/UPSTREAM`)) {
        log(`    note: ${from} has no brand/UPSTREAM, so a real run stops here; ${NO_BASE_HINT}`);
      }
      for (const step of buildSteps(ctx)) {
        log(step.title);
        for (const { show } of step.commands) log(`    ${show}`);
      }
      log('6. summary and walk checklist');
      return { status: 'planned' };
    }

    if (!resume) {
      if (git('status', '--porcelain', '--untracked-files=no') !== '') {
        throw new Stop('start', 'the working tree has uncommitted changes', 'commit or stash them first');
      }
      if (fetch) {
        log(`[mittr] git fetch ${remote}`);
        git('fetch', '--quiet', remote);
      }
      resolve();
      if (!git.ok('rev-parse', '--verify', `${from}^{commit}`)) throw new Stop('start', `${from} does not exist here`, 'pass --from <branch>');
      if (!git.ok('cat-file', '-e', `${from}:brand/UPSTREAM`)) {
        throw new Stop('start', `${from} has no brand/UPSTREAM, so it is not on the upstream-based line`, NO_BASE_HINT);
      }
      if (git.ok('rev-parse', '--verify', '--quiet', `refs/heads/${ctx.branch}`)) {
        throw new Stop('start', `${ctx.branch} already exists`, `switch to it and run with --continue, or delete it to start over`);
      }
      if (git.ok('merge-base', '--is-ancestor', ctx.sha, from)) {
        throw new Stop('start', `${from} already contains ${ctx.short}`, 'nothing to update');
      }
    } else {
      resolve();
      const current = git('rev-parse', '--abbrev-ref', 'HEAD');
      if (current !== ctx.branch) throw new Stop('start', `--continue runs on ${ctx.branch}, not ${current}`, `git switch ${ctx.branch}`);
      if (git.ok('rev-parse', '-q', '--verify', 'MERGE_HEAD')) throw new Stop('merge', 'the merge is not committed yet', 'resolve, git add, git commit');
      if (!git.ok('merge-base', '--is-ancestor', ctx.sha, 'HEAD')) throw new Stop('merge', `${ctx.short} is not merged into ${ctx.branch}`, 'run without --continue');
      if (git('status', '--porcelain', '--untracked-files=no') !== '') {
        throw new Stop('start', 'the working tree has uncommitted changes', 'commit them on the update branch first');
      }
    }

    for (const step of buildSteps(ctx)) {
      if (resume && step.skipOnResume) continue;
      log(`\n[mittr] ${step.title}`);
      for (const { exec } of step.commands) exec();
    }

    log(summary(ctx, `done: ${ctx.branch} is merged and checked. Nothing was pushed.`));
    log('\n[mittr] walk checklist before anything leaves this machine:');
    for (const item of WALK_CHECKLIST) log(`  [ ] ${item}`);
    return { status: 'done' };
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    const resumable = ['record', 'checks', 'build', 'merge'].includes(error.step);
    const again = resumable ? `; then: node scripts/mittr/upstream-update.mjs ${ctx.short ?? commit} --continue` : '';
    log(`\n[mittr] stopped at ${error.step}: ${error.message}`);
    log(summary(ctx, `next: ${error.next}${again}`));
    return { status: 'stopped', step: error.step };
  }
};

const USAGE = `Usage: node scripts/mittr/upstream-update.mjs <upstream-commit> [options]

Merges an upstream OpenChamber commit into upstream-update/<short-sha>, branched
from --from, then runs the touch check, install, contract tests, type-check,
lint, tests against the recorded baseline, the visible-string check, the Dev
build and the brand-leak scan.
It never pushes and never merges with -X ours/theirs.

Options (also as --option=value):
  --from <branch>    branch to start from (default: develop). Until phase 5,
                     develop has no brand/UPSTREAM: pass --from ${REBASED_LINE}
  --remote <name>    remote that mirrors upstream (default: origin)
  --no-fetch         do not fetch the remote first
  --dry-run          print the plan; run nothing
  --continue         after fixing and committing on the update branch, run
                     again from recording the base
  -h, --help         print this and exit`;

const VALUE_OPTIONS = { '--from': 'from', '--remote': 'remote' };
const FLAG_OPTIONS = { '--no-fetch': ['fetch', false], '--dry-run': ['dryRun', true], '--continue': ['resume', true], '--help': ['help', true], '-h': ['help', true] };

/** Only the options this command knows; anything else is an error, never ignored. */
export const parseUpdateArgs = (argv) => {
  const options = { commit: undefined, from: 'develop', remote: 'origin', fetch: true, dryRun: false, resume: false, help: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (Object.hasOwn(FLAG_OPTIONS, name)) {
      if (equals !== -1) throw new Error(`${name} takes no value`);
      const [key, value] = FLAG_OPTIONS[name];
      options[key] = value;
    } else if (Object.hasOwn(VALUE_OPTIONS, name)) {
      const value = equals === -1 ? argv[(index += 1)] : arg.slice(equals + 1);
      if (!value || value.startsWith('-')) throw new Error(`${name} needs a value`);
      options[VALUE_OPTIONS[name]] = value;
    } else {
      throw new Error(`unknown option ${name}`);
    }
  }
  if (options.help) return options;
  if (positional.length === 0) throw new Error('no upstream commit given');
  if (positional.length > 1) throw new Error(`expected one upstream commit, got ${positional.join(' ')}`);
  if (options.dryRun && options.resume) throw new Error('--dry-run and --continue cannot be combined');
  return { ...options, commit: positional[0] };
};

/** The command line: returns the exit code. */
export const main = (argv, { cwd, run, log = console.log, error = console.error } = {}) => {
  let options;
  try {
    options = parseUpdateArgs(argv);
  } catch (problem) {
    error(`[mittr] ${problem.message}; see --help`);
    return 1;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }
  const { help: _help, ...update } = options;
  const request = { cwd, log, ...update };
  if (run) request.run = run;
  const result = runUpstreamUpdate(request);
  return result.status === 'stopped' ? 1 : 0;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  try {
    process.exitCode = main(process.argv.slice(2), { cwd: repoRoot });
  } catch (error) {
    console.error(`[mittr] ${error.stderr || error.message}`);
    process.exitCode = 1;
  }
}

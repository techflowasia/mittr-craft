import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { checkUpstreamTouch, formatTouchReport, parseTouchArgs, patchPathFor, patchPathsFor, upstreamPathOf } from './check-upstream-touch.mjs';

// No GIT_* variable from the caller: run from a git hook, GIT_DIR or
// GIT_INDEX_FILE would point every fixture command at the real repository.
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

const fixtureRepo = (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-touch-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).trim();
  const write = (relative, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), content);
  };
  const commit = (subject, files) => {
    for (const [relative, content] of Object.entries(files)) write(relative, content);
    git('add', '-A');
    git('commit', '-q', '-m', subject);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  return { dir, git, write, commit };
};

// An upstream release, then our history on top of it the way the rules allow
// and one commit that breaks them.
const ourHistory = (t) => {
  const repo = fixtureRepo(t);
  const base = repo.commit('release v1.0.0', {
    'packages/web/a.js': 'a\n',
    'packages/web/a.test.js': 'test a\n',
    'packages/web/b.js': 'b\n',
    'docs/upstream.md': 'upstream doc\n',
    'bun.lock': 'lock 1\n',
  });
  repo.commit('chore(brand): record upstream base', { 'brand/UPSTREAM': `${base}\n` });
  repo.commit('hook(a): let a be configured', {
    'packages/web/a.js': 'a with hook\n',
    'packages/web/a.test.js': 'test a with hook\n',
    'packages/web/new.js': 'generic new module\n',
  });
  repo.commit('feat(mittr-x): a package of ours', {
    'packages/mittr-x/index.js': 'ours\n',
    'docs/ours.md': 'our doc\n',
    'bun.lock': 'lock 2\n',
  });
  const offender = repo.commit('docs(mittr): reword an upstream doc', { 'docs/upstream.md': 'reworded\n' });
  return { ...repo, base, offender };
};

test('lists every upstream file we touched, counts the source and config ones, and reports a non-hook commit', (t) => {
  const repo = ourHistory(t);
  const result = checkUpstreamTouch({ cwd: repo.dir, write: false });

  assert.equal(result.base, repo.base);
  assert.deepEqual(result.counted, ['bun.lock', 'docs/upstream.md', 'packages/web/a.js']);
  assert.deepEqual(result.added, ['packages/web/new.js']);
  assert.deepEqual(result.tests, ['packages/web/a.test.js']);
  assert.deepEqual(result.violations, [{
    commit: repo.offender,
    subject: 'docs(mittr): reword an upstream doc',
    files: ['docs/upstream.md'],
  }]);
  assert.equal(result.ok, false);

  const report = formatTouchReport(result);
  assert.match(report, /upstream files touched: 3 of 24/);
  assert.match(report, /bun\.lock .*re-resolve with `bun install`/);
  assert.match(report, /docs\(mittr\): reword an upstream doc/);
});

test('a reviewed exception is reported but does not fail the check', (t) => {
  const repo = ourHistory(t);
  const result = checkUpstreamTouch({ cwd: repo.dir, write: false, acknowledged: { [repo.offender]: 'reviewed' } });

  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.acknowledged.map(({ commit, reason }) => [commit, reason]), [[repo.offender, 'reviewed']]);
  assert.equal(result.ok, true);
  assert.match(formatTouchReport(result), /acknowledged.*reviewed/s);
});

test('more files than the cap fails', (t) => {
  const repo = ourHistory(t);
  const result = checkUpstreamTouch({ cwd: repo.dir, write: false, cap: 2, acknowledged: { [repo.offender]: 'reviewed' } });

  assert.equal(result.ok, false);
  assert.match(formatTouchReport(result), /3 of 2.*over the cap/s);
});

const listPatches = (root) => fs.readdirSync(root, { recursive: true })
  .filter((entry) => entry.endsWith('.patch'))
  .map((entry) => entry.split(path.sep).join('/'))
  .sort();

test('writes one readable patch per touched upstream file except the lockfile, mirroring the tree, and drops stale ones', (t) => {
  const repo = ourHistory(t);
  repo.write('patches/upstream/packages/old/gone.js.patch', 'stale\n');
  repo.write('patches/upstream/packages__web__a.js.patch', 'old flat name\n');

  const result = checkUpstreamTouch({ cwd: repo.dir });
  const root = path.join(repo.dir, 'patches/upstream');

  assert.deepEqual(listPatches(root), [
    'docs/upstream.md.patch',
    'packages/web/a.js.patch',
    'packages/web/a.test.js.patch',
    'packages/web/new.js.patch',
  ]);
  assert.deepEqual(result.patches.removed, ['packages/old/gone.js.patch', 'packages__web__a.js.patch']);
  assert.equal(fs.existsSync(path.join(root, 'packages/old')), false);
  const patch = fs.readFileSync(path.join(root, patchPathFor('packages/web/a.js')), 'utf8');
  assert.match(patch, /^diff --git a\/packages\/web\/a\.js b\/packages\/web\/a\.js/);
  assert.match(patch, /^\+a with hook$/m);
});

test('patch paths round-trip to the upstream path and never collide', () => {
  const files = ['a/b__c', 'a__b/c', 'packages/ui/src/__tests__/x.test.ts', 'packages/ui/src/__tests__', 'x.patch', 'x'];
  for (const file of files) assert.equal(upstreamPathOf(patchPathFor(file)), file);
  assert.equal(new Set(patchPathsFor(['a/b__c', 'a__b/c'])).size, 2);
  assert.throws(() => patchPathsFor(['foo', 'foo.patch/bar.js']), /foo\.patch/);
});

test('the command line takes only the options it knows', () => {
  assert.deepEqual(parseTouchArgs([]), { write: true, help: false });
  assert.deepEqual(parseTouchArgs(['--no-write']), { write: false, help: false });
  assert.deepEqual(parseTouchArgs(['--help']), { write: true, help: true });
  assert.throws(() => parseTouchArgs(['--nowrite']), /unknown option --nowrite/);
  assert.throws(() => parseTouchArgs(['--no-write=yes']), /takes no value/);
  assert.throws(() => parseTouchArgs(['extra']), /no arguments/);
});

test('after an upstream merge only our changes count, and upstream commits and the merge are not ours to name', (t) => {
  const repo = ourHistory(t);
  repo.git('checkout', '-q', '-b', 'upstream', repo.base);
  const next = repo.commit('release v1.1.0', { 'packages/web/b.js': 'b changed upstream\n', 'packages/web/c.js': 'c\n' });
  repo.git('checkout', '-q', 'main');
  repo.git('merge', '-q', '--no-ff', '--no-edit', 'upstream');
  repo.commit('chore(brand): record upstream base', { 'brand/UPSTREAM': `${next}\n` });

  const result = checkUpstreamTouch({ cwd: repo.dir, write: false, acknowledged: { [repo.offender]: 'reviewed' } });

  assert.equal(result.base, next);
  assert.deepEqual(result.counted, ['bun.lock', 'docs/upstream.md', 'packages/web/a.js']);
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
});

test('a commit that touches only the lockfile needs no hook subject', (t) => {
  const repo = ourHistory(t);
  repo.commit('chore(deps): re-resolve after an upstream update', { 'bun.lock': 'lock 3\n' });

  const result = checkUpstreamTouch({ cwd: repo.dir, write: false, acknowledged: { [repo.offender]: 'reviewed' } });

  assert.deepEqual(result.violations, []);
});

test('after develop adopts the line with an ours-merge, the 1.x history on its other side is not checked', (t) => {
  const repo = fixtureRepo(t);
  repo.commit('release v0.9.0', { 'packages/web/a.js': 'a 0.9\n', 'packages/web/b.js': 'b\n' });
  repo.git('switch', '-q', '-c', 'develop');
  repo.commit('feat: rename the product everywhere', { 'packages/web/a.js': 'a 0.9 renamed\n', 'packages/web/b.js': 'b renamed\n' });
  repo.commit('fix: a 1.x change', { 'packages/web/c.js': 'c from 1.x\n' });

  repo.git('switch', '-q', 'main');
  const base = repo.commit('release v1.0.0', { 'packages/web/a.js': 'a 1.0\n' });
  repo.git('switch', '-q', '-c', 'rebase');
  repo.commit('chore(brand): record upstream base', { 'brand/UPSTREAM': `${base}\n` });
  repo.commit('hook(a): let a be configured', { 'packages/web/a.js': 'a 1.0 with hook\n' });
  const onLine = checkUpstreamTouch({ cwd: repo.dir, write: false });

  repo.git('switch', '-q', 'develop');
  repo.git('merge', '-q', '-s', 'ours', '--no-commit', 'rebase');
  repo.git('read-tree', '-m', '-u', 'rebase');
  repo.git('commit', '-q', '-m', 'chore: adopt the upstream-based line');
  assert.equal(repo.git('rev-parse', 'HEAD^{tree}'), repo.git('rev-parse', 'rebase^{tree}'));
  assert.match(repo.git('log', '--no-merges', '--format=%s', `${base}..HEAD`), /rename the product everywhere/);

  const adopted = checkUpstreamTouch({ cwd: repo.dir, write: false });

  assert.deepEqual(adopted.violations, []);
  assert.deepEqual(adopted.counted, onLine.counted);
  assert.deepEqual(adopted.counted, ['packages/web/a.js']);
  assert.equal(adopted.ok, true);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runUpstreamUpdate } from './upstream-update.mjs';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

// The script runs git with the process environment; the fixture's identity
// and empty global config must reach it too.
const withGitEnv = (t) => {
  const saved = Object.fromEntries(Object.keys(GIT_ENV).map((key) => [key, process.env[key]]));
  Object.assign(process.env, GIT_ENV);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
};

const HOOK_BODY = 'Lets a build name its own greeting. Without this the greeting is fixed in the file.';

// A throwaway pair of repositories: `remote.git` stands in for the upstream
// mirror, and the clone holds our develop with one hook on the upstream file.
const fixture = (t, { conflicting = false } = {}) => {
  withGitEnv(t);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-update-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const dir = path.join(root, 'work');
  const gitAt = (cwd) => (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const git = gitAt(dir);
  const write = (relative, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), content);
  };
  const commit = (message, files) => {
    for (const [relative, content] of Object.entries(files)) write(relative, content);
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };

  fs.mkdirSync(dir);
  git('init', '-q', '-b', 'main');
  const base = commit('release v1.0.0', {
    'packages/web/a.js': 'greeting = "hello"\n',
    'packages/web/b.js': 'b\n',
    'bun.lock': 'lock upstream 1\n',
  });
  git('switch', '-q', '-c', 'develop');
  commit('chore(brand): record upstream base', {
    'brand/UPSTREAM': `${base}\n`,
    'brand/electron-builder.dev.json': JSON.stringify({ productName: 'Fixture Dev' }),
  });
  commit(`hook(greeting): take the greeting from the product\n\n${HOOK_BODY}\n\nA second paragraph.`, {
    'packages/web/a.js': 'greeting = product.greeting ?? "hello"\n',
  });
  commit('feat(mittr-x): our package', {
    'packages/mittr-x/package.json': JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }),
    'packages/mittr-y/package.json': JSON.stringify({ name: 'y', scripts: {} }),
    'bun.lock': 'lock upstream 1 plus ours\n',
  });

  git('switch', '-q', 'main');
  const next = conflicting
    ? commit('release v1.1.0', { 'packages/web/a.js': 'greeting = "hi"\n', 'bun.lock': 'lock upstream 2\n' })
    : commit('release v1.1.0', { 'packages/web/b.js': 'b changed\n', 'packages/web/c.js': 'c\n' });
  git('switch', '-q', 'develop');

  execFileSync('git', ['clone', '-q', '--bare', dir, remote]);
  git('remote', 'add', 'origin', remote);
  git('branch', '-q', '-D', 'main');
  git('fetch', '-q', 'origin');

  const remoteRefs = () => gitAt(remote)('for-each-ref', '--format=%(refname) %(objectname)');
  return { dir, git, write, commit, base, next, short: next.slice(0, 9), develop: git('rev-parse', 'develop'), remoteRefs, initialRemoteRefs: remoteRefs() };
};

// Stands in for every non-git command: records it, fails the ones asked to,
// and lays down the app a Dev build would produce.
const recordingRunner = (dir, { failOn } = {}) => {
  const calls = [];
  const run = ({ command, args }) => {
    const line = [path.basename(command), ...args].join(' ');
    calls.push(line);
    if (failOn && line.includes(failOn)) return 1;
    if (args.includes('--flavor') && !args.includes('--check-strings')) {
      fs.mkdirSync(path.join(dir, 'packages/electron/dist/mac-arm64/Fixture Dev.app'), { recursive: true });
    }
    return 0;
  };
  return { calls, run };
};

const capture = () => {
  const lines = [];
  return { lines, log: (line = '') => lines.push(String(line)), text: () => lines.join('\n') };
};

test('dry run prints the whole plan and changes nothing', (t) => {
  const repo = fixture(t);
  const before = repo.git('for-each-ref', '--format=%(refname) %(objectname)');
  const output = capture();
  const runner = recordingRunner(repo.dir);

  const result = runUpstreamUpdate({ cwd: repo.dir, commit: 'origin/main', dryRun: true, run: runner.run, log: output.log });

  assert.equal(result.status, 'planned');
  assert.deepEqual(runner.calls, []);
  assert.equal(repo.git('for-each-ref', '--format=%(refname) %(objectname)'), before);
  assert.equal(repo.git('rev-parse', '--abbrev-ref', 'HEAD'), 'develop');
  assert.throws(() => repo.git('config', '--get', 'rerere.enabled'));

  const text = output.text();
  assert.match(text, new RegExp(`upstream-update/${repo.short}`));
  assert.match(text, /git merge --no-ff --no-edit/);
  assert.doesNotMatch(text, /git push|-X (ours|theirs)/);
  for (const expected of ['bun install', 'upstream-contract.test.js', 'bun run type-check', 'bun run lint', 'bun run test', 'bun run --cwd packages/mittr-x test', 'run-isolated-tests.mjs scripts/mittr']) {
    assert.ok(text.includes(expected), `plan lacks ${expected}`);
  }
  assert.ok(!text.includes('packages/mittr-y'), 'a package without tests is not run');
  assert.ok(text.indexOf('--check-strings') < text.indexOf('build-desktop.mjs --flavor dev'), 'strings are checked before the build');
});

test('a clean update merges on its own branch, records the base, runs every gate in order and never pushes', (t) => {
  const repo = fixture(t);
  const output = capture();
  const runner = recordingRunner(repo.dir);

  const result = runUpstreamUpdate({ cwd: repo.dir, commit: 'origin/main', run: runner.run, log: output.log });

  assert.equal(result.status, 'done', output.text());
  assert.equal(repo.git('rev-parse', '--abbrev-ref', 'HEAD'), `upstream-update/${repo.short}`);
  assert.equal(repo.git('rev-parse', 'develop'), repo.develop);
  assert.equal(repo.git('show', 'HEAD:brand/UPSTREAM'), repo.next);
  assert.equal(repo.git('merge-base', '--is-ancestor', repo.next, 'HEAD'), '');
  assert.equal(repo.git('config', '--get', 'rerere.enabled'), 'true');
  assert.ok(fs.existsSync(path.join(repo.dir, 'patches/upstream/packages__web__a.js.patch')));
  assert.equal(repo.git('status', '--porcelain', '--untracked-files=no'), '');
  assert.equal(repo.remoteRefs(), repo.initialRemoteRefs);

  const order = [
    'bun install',
    'upstream-contract.test.js',
    'bun run type-check',
    'bun run lint',
    'bun run test',
    'bun run --cwd packages/mittr-x test',
    'run-isolated-tests.mjs scripts/mittr',
    'build-desktop.mjs --check-strings --flavor dev',
    'build-desktop.mjs --flavor dev',
    'brand-leak-scan.mjs',
  ];
  const positions = order.map((needle) => runner.calls.findIndex((call) => call.includes(needle)));
  assert.ok(positions.every((position) => position >= 0), `missing: ${order.filter((_, index) => positions[index] < 0)}\n${runner.calls.join('\n')}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.ok(runner.calls.at(-1).includes('Fixture Dev.app'));

  assert.match(output.text(), /upstream files touched: 2 of 24/);
  assert.match(output.text(), /walk/i);
});

test('a conflict stops the update and names the hook that owns each file, with its reason', (t) => {
  const repo = fixture(t, { conflicting: true });
  const output = capture();
  const runner = recordingRunner(repo.dir);

  const result = runUpstreamUpdate({ cwd: repo.dir, commit: 'origin/main', run: runner.run, log: output.log });

  assert.equal(result.status, 'stopped');
  assert.equal(result.step, 'merge');
  assert.deepEqual(runner.calls, []);
  assert.equal(repo.git('rev-parse', 'develop'), repo.develop);
  assert.ok(repo.git('rev-parse', '-q', '--verify', 'MERGE_HEAD'));

  const text = output.text();
  assert.match(text, /packages\/web\/a\.js/);
  assert.match(text, /hook\(greeting\): take the greeting from the product/);
  assert.ok(text.includes(HOOK_BODY), text);
  assert.ok(!text.includes('A second paragraph'));
  assert.match(text, /bun\.lock[\s\S]*bun install/);
  assert.match(text, /--continue/);
  assert.match(text, /upstream files touched before this merge: 2 of 24/);
});

test('after the conflict is resolved and committed, --continue runs the rest', (t) => {
  const repo = fixture(t, { conflicting: true });
  runUpstreamUpdate({ cwd: repo.dir, commit: 'origin/main', run: recordingRunner(repo.dir).run, log: () => {} });
  repo.write('packages/web/a.js', 'greeting = product.greeting ?? "hi"\n');
  repo.git('checkout', 'MERGE_HEAD', '--', 'bun.lock');
  repo.git('add', '-A');
  repo.git('commit', '-q', '--no-edit');

  const output = capture();
  const runner = recordingRunner(repo.dir);
  const result = runUpstreamUpdate({ cwd: repo.dir, commit: 'origin/main', resume: true, run: runner.run, log: output.log });

  assert.equal(result.status, 'done', output.text());
  assert.equal(repo.git('show', 'HEAD:brand/UPSTREAM'), repo.next);
  assert.ok(runner.calls.some((call) => call.includes('brand-leak-scan.mjs')));
});

test('a failing gate stops with the next action and still reports the touch count', (t) => {
  const repo = fixture(t);
  const output = capture();
  const runner = recordingRunner(repo.dir, { failOn: 'type-check' });

  const result = runUpstreamUpdate({ cwd: repo.dir, commit: 'origin/main', run: runner.run, log: output.log });

  assert.equal(result.status, 'stopped');
  assert.ok(runner.calls.at(-1).includes('type-check'));
  assert.ok(!runner.calls.some((call) => call.includes('build-desktop')));
  assert.match(output.text(), /upstream files touched: 2 of 24/);
  assert.match(output.text(), new RegExp(`upstream-update\\.mjs ${repo.short} --continue`));
});

test('refuses to start over uncommitted changes, from a branch without a recorded base, or onto an existing update branch', (t) => {
  const repo = fixture(t);
  repo.write('packages/web/b.js', 'local edit\n');
  const dirty = runUpstreamUpdate({ cwd: repo.dir, commit: 'origin/main', run: () => 0, log: () => {} });
  assert.equal(dirty.status, 'stopped');
  assert.equal(repo.git('rev-parse', '--abbrev-ref', 'HEAD'), 'develop');
  repo.git('checkout', '--', 'packages/web/b.js');

  repo.git('branch', 'old-line', repo.base);
  const oldLine = runUpstreamUpdate({ cwd: repo.dir, commit: 'origin/main', from: 'old-line', run: () => 0, log: () => {} });
  assert.equal(oldLine.status, 'stopped');
  assert.equal(repo.git('rev-parse', '--abbrev-ref', 'HEAD'), 'develop');

  repo.git('branch', `upstream-update/${repo.short}`, 'develop');
  const exists = runUpstreamUpdate({ cwd: repo.dir, commit: 'origin/main', run: () => 0, log: () => {} });
  assert.equal(exists.status, 'stopped');
  assert.equal(repo.git('rev-parse', '--abbrev-ref', 'HEAD'), 'develop');
});

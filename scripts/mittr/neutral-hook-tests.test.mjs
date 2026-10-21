import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { findProductWordsInHookTests, formatFindings } from './neutral-hook-tests.mjs';

const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

const fixtureRepo = (t, baseFiles) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'neutral-tests-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).trim();
  const commit = (subject, files) => {
    for (const [relative, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
      fs.writeFileSync(path.join(dir, relative), content);
    }
    git('add', '-A');
    git('commit', '-q', '-m', subject);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  const base = commit('release v1.0.0', {
    'packages/web/old.test.js': 'test("old", () => {});\n',
    'packages/web/unchanged.test.js': "const name = 'Mittr';\n",
    'packages/web/a.js': 'a\n',
    ...baseFiles,
  });
  return { dir, git, commit, base };
};

test('a hook test that names the product is reported with its line', (t) => {
  const { dir, commit, base } = fixtureRepo(t);
  commit('hook(x): a hook', { 'packages/web/x.test.js': "const a = 1;\nconst provider = 'mittr';\n" });
  assert.deepEqual(findProductWordsInHookTests({ cwd: dir, base }), [
    { file: 'packages/web/x.test.js', line: 2, text: "const provider = 'mittr';" },
  ]);
});

test('the product name is found in any case and inside longer names', (t) => {
  const { dir, commit, base } = fixtureRepo(t);
  commit('hook(x): a hook', {
    'packages/ui/src/a.test.tsx': "'Mittr Writer'\n'MittrCraft'\n'api-dev.mittr.asia'\n'MITTRCRAFT_BROKER_URL'\n",
  });
  assert.deepEqual(findProductWordsInHookTests({ cwd: dir, base }).map((finding) => finding.line), [1, 2, 3, 4]);
});

test('our own packages are not scanned', (t) => {
  const { dir, commit, base } = fixtureRepo(t);
  commit('feat(mittr-ui): ours', {
    'packages/mittr-ui/a.test.ts': "'mittr'\n",
    'packages/mittr-server/src/b.test.js': "'mittr'\n",
    'scripts/mittr/c.test.mjs': "'mittr'\n",
    'brand/d.test.js': "'mittr'\n",
    'docs/e.test.js': "'mittr'\n",
  });
  assert.deepEqual(findProductWordsInHookTests({ cwd: dir, base }), []);
});

test('a test upstream already had under one of our folders is still upstream', (t) => {
  const { dir, commit, base } = fixtureRepo(t, { 'docs/upstream.test.js': 'ok\n' });
  commit('hook(x): a hook', { 'docs/upstream.test.js': "'mittr'\n" });
  assert.deepEqual(findProductWordsInHookTests({ cwd: dir, base }).map((finding) => finding.file), ['docs/upstream.test.js']);
});

test('files that are not tests are not scanned', (t) => {
  const { dir, commit, base } = fixtureRepo(t);
  commit('hook(x): a hook', { 'packages/web/a.js': "'mittr'\n" });
  assert.deepEqual(findProductWordsInHookTests({ cwd: dir, base }), []);
});

test('a test the base already named the product in, and left alone, is not scanned', (t) => {
  const { dir, commit, base } = fixtureRepo(t);
  commit('hook(x): a hook', { 'packages/web/other.js': 'b\n' });
  assert.deepEqual(findProductWordsInHookTests({ cwd: dir, base }), []);
});

test('a deleted test file is skipped', (t) => {
  const { dir, commit, base } = fixtureRepo(t);
  fs.rmSync(path.join(dir, 'packages/web/unchanged.test.js'));
  commit('hook(x): remove', {});
  assert.deepEqual(findProductWordsInHookTests({ cwd: dir, base }), []);
});

test('the report counts findings and names each one', () => {
  assert.equal(formatFindings([]), '0 findings');
  assert.equal(
    formatFindings([{ file: 'packages/web/x.test.js', line: 2, text: "const a = 'mittr';" }]),
    "packages/web/x.test.js:2: const a = 'mittr';\n1 finding",
  );
});

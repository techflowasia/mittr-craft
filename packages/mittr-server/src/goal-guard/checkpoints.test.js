import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CHECKPOINT_KEEP,
  UNTRACKED_FILE_COUNT_LIMIT,
  UNTRACKED_FILE_LIMIT_BYTES,
  checkpointLine,
  recordCheckpoint,
  removeCheckpoints,
  sweepCheckpoints,
} from './checkpoints.js';

const SESSION = 'ses_decfc5c5affer72abO44MN00fY';
const roots = [];

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' },
}).trim();

const repository = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-checkpoint-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'lead.ts'), 'export const kept = 1;\n');
  fs.writeFileSync(path.join(root, 'staged.ts'), 'one\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'start');
  return root;
};

const fingerprint = (root) => ({
  status: git(root, 'status', '--porcelain=v1', '--untracked-files=all'),
  index: createHash('sha256').update(fs.readFileSync(path.join(root, '.git', 'index'))).digest('hex'),
  files: Object.fromEntries(fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !path.relative(root, entry.parentPath).split(path.sep).includes('.git'))
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(root, file), createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
    })),
  stashes: git(root, 'stash', 'list'),
});

const refs = (root) => git(root, 'for-each-ref', '--format=%(refname)', `refs/mittrcraft/goal/${SESSION}/`).split('\n').filter(Boolean);

test('records uncommitted work under a goal ref without changing files, index or the stash list', async () => {
  const root = repository();
  fs.writeFileSync(path.join(root, 'lead.ts'), 'export const kept = 2;\n');
  fs.writeFileSync(path.join(root, 'staged.ts'), 'two\n');
  git(root, 'add', 'staged.ts');
  fs.writeFileSync(path.join(root, 'new.ts'), 'untracked\n');
  const before = fingerprint(root);

  const saved = await recordCheckpoint({ directory: root, sessionId: SESSION });

  assert.deepEqual(fingerprint(root), before);
  assert.deepEqual(saved.refs, [`refs/mittrcraft/goal/${SESSION}/1`]);
  assert.equal(saved.head, git(root, 'rev-parse', 'HEAD'));
  assert.equal(git(root, 'show', `${saved.refs[0]}:lead.ts`), 'export const kept = 2;');
  assert.equal(git(root, 'show', `${saved.refs[0]}:staged.ts`), 'two');
  assert.equal(git(root, 'show', `${saved.refs[0]}:new.ts`), 'untracked');
  assert.deepEqual(saved.newFiles, { saved: 1, large: 0, secret: 0, overCap: false, failed: false });
});

test('new files are saved too, except ignored ones and single files over the size limit', async () => {
  const root = repository();
  fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\n');
  git(root, 'add', '.gitignore');
  git(root, 'commit', '-q', '-m', 'ignore dist');
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'bundle.js'), 'built\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'answer-stream.ts'), 'export const stream = 1;\n');
  fs.writeFileSync(path.join(root, 'recording.mov'), Buffer.alloc(UNTRACKED_FILE_LIMIT_BYTES + 1));
  const before = fingerprint(root);

  const saved = await recordCheckpoint({ directory: root, sessionId: SESSION });
  const files = git(root, 'ls-tree', '-r', '--name-only', saved.refs[0]).split('\n');

  assert.deepEqual(fingerprint(root), before);
  assert.equal(UNTRACKED_FILE_LIMIT_BYTES, 5 * 1024 * 1024);
  assert.ok(files.includes('src/answer-stream.ts'));
  assert.equal(files.includes('dist/bundle.js'), false);
  assert.equal(files.includes('recording.mov'), false);
  assert.equal(saved.newFiles.large, 1);
  assert.match(checkpointLine(saved.refs, saved.newFiles), /Left out: 1 new file over 5 MB\./);
});

test('a deleted new file comes back with git stash apply', async () => {
  const root = repository();
  fs.writeFileSync(path.join(root, 'fresh.ts'), 'export const fresh = true;\n');
  const saved = await recordCheckpoint({ directory: root, sessionId: SESSION });

  fs.rmSync(path.join(root, 'fresh.ts'));
  git(root, 'stash', 'apply', saved.refs[0]);

  assert.equal(fs.readFileSync(path.join(root, 'fresh.ts'), 'utf8'), 'export const fresh = true;\n');
});

test('a person gets discarded work back with git stash apply', async () => {
  const root = repository();
  fs.writeFileSync(path.join(root, 'lead.ts'), 'export const kept = 3;\n');
  const saved = await recordCheckpoint({ directory: root, sessionId: SESSION });

  git(root, 'checkout', '--', 'lead.ts');
  git(root, 'stash', 'apply', saved.refs[0]);

  assert.equal(fs.readFileSync(path.join(root, 'lead.ts'), 'utf8'), 'export const kept = 3;\n');
});

test('a clean tree records nothing but still reports where HEAD and the tree are', async () => {
  const root = repository();

  const saved = await recordCheckpoint({ directory: root, sessionId: SESSION });

  assert.deepEqual(saved, {
    head: git(root, 'rev-parse', 'HEAD'),
    tree: git(root, 'rev-parse', 'HEAD^{tree}'),
    refs: [],
    newFiles: { saved: 0, large: 0, secret: 0, overCap: false, failed: false },
  });
  assert.deepEqual(refs(root), []);
});

test('unchanged work since the newest checkpoint records no second one, changed work does', async () => {
  const root = repository();
  fs.writeFileSync(path.join(root, 'lead.ts'), 'export const kept = 4;\n');

  const first = await recordCheckpoint({ directory: root, sessionId: SESSION });
  const again = await recordCheckpoint({ directory: root, sessionId: SESSION });
  fs.writeFileSync(path.join(root, 'lead.ts'), 'export const kept = 5;\n');
  const changed = await recordCheckpoint({ directory: root, sessionId: SESSION });

  assert.deepEqual(again.refs, first.refs);
  assert.equal(again.tree, first.tree);
  assert.notEqual(changed.tree, first.tree);
  assert.deepEqual(changed.refs, [`refs/mittrcraft/goal/${SESSION}/2`, `refs/mittrcraft/goal/${SESSION}/1`]);
});

test('keeps the newest checkpoints and deletes older refs', async () => {
  const root = repository();
  for (let index = 0; index < 5; index += 1) {
    fs.writeFileSync(path.join(root, 'lead.ts'), `export const kept = ${10 + index};\n`);
    await recordCheckpoint({ directory: root, sessionId: SESSION, keep: 3 });
  }

  assert.equal(CHECKPOINT_KEEP, 20);
  assert.deepEqual(refs(root).sort(), [3, 4, 5].map((n) => `refs/mittrcraft/goal/${SESSION}/${n}`));
});

test('records nothing outside a git work tree, before a first commit, or for an unsafe session id', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-checkpoint-plain-'));
  roots.push(plain);
  const unborn = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-checkpoint-unborn-'));
  roots.push(unborn);
  git(unborn, 'init', '-q');
  fs.writeFileSync(path.join(unborn, 'a.ts'), 'a\n');
  const root = repository();
  fs.writeFileSync(path.join(root, 'lead.ts'), 'changed\n');

  assert.equal(await recordCheckpoint({ directory: plain, sessionId: SESSION }), null);
  assert.equal(await recordCheckpoint({ directory: unborn, sessionId: SESSION }), null);
  assert.equal(await recordCheckpoint({ directory: root, sessionId: '../../heads/main' }), null);
  assert.equal(git(root, 'rev-parse', 'main'), git(root, 'rev-parse', 'HEAD'));
});

test('the agent line names the newest checkpoints and how to restore one', () => {
  const line = checkpointLine([5, 4, 3, 2].map((n) => `refs/mittrcraft/goal/${SESSION}/${n}`));

  assert.equal(line.includes('\n'), false);
  assert.match(line, new RegExp(`refs/mittrcraft/goal/${SESSION}/5, refs/mittrcraft/goal/${SESSION}/4, refs/mittrcraft/goal/${SESSION}/3`));
  assert.equal(line.includes('/2'), false);
  assert.match(line, /git stash apply/);
  assert.doesNotMatch(line, /left out|not saved/i);
  assert.equal(checkpointLine([]), '');
});

test('secret-looking new files never go into a checkpoint', async () => {
  const root = repository();
  const secrets = ['.env', '.env.local', 'server.pem', 'deploy.key', 'id_rsa', 'id_ed25519.pub', 'cert.p12', 'aws-credentials.json', 'config/secrets.yaml'];
  fs.mkdirSync(path.join(root, 'config'));
  for (const name of secrets) fs.writeFileSync(path.join(root, name), 'do not copy\n');
  fs.writeFileSync(path.join(root, 'notes.md'), 'keep\n');

  const saved = await recordCheckpoint({ directory: root, sessionId: SESSION });
  const files = git(root, 'ls-tree', '-r', '--name-only', saved.refs[0]).split('\n');

  assert.ok(files.includes('notes.md'));
  for (const name of secrets) assert.equal(files.includes(name), false, name);
  assert.equal(saved.newFiles.secret, secrets.length);
  assert.match(checkpointLine(saved.refs, saved.newFiles), /9 secret-looking new files/);
});

test('new file names are taken literally, a leading space and a colon included', async () => {
  const root = repository();
  const names = [' lead.ts', ':colon.txt', '*star.txt', '[set].md'];
  for (const name of names) fs.writeFileSync(path.join(root, name), `${name}\n`);
  const before = fingerprint(root);

  const saved = await recordCheckpoint({ directory: root, sessionId: SESSION });
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', saved.refs[0]], { cwd: root, encoding: 'utf8' }).split('\0');

  assert.deepEqual(fingerprint(root), before);
  for (const name of names) assert.ok(files.includes(name), name);
  assert.equal(saved.newFiles.saved, names.length);
});

test('past the new-file cap the checkpoint keeps the tracked work and says the new files were not saved', async () => {
  const root = repository();
  fs.writeFileSync(path.join(root, 'lead.ts'), 'export const kept = 9;\n');
  const deep = path.join(root, 'generated', 'a-folder-name-that-is-long-enough-to-matter', 'and-one-more-level-of-it');
  fs.mkdirSync(deep, { recursive: true });
  for (let index = 0; index < 22_000; index += 1) fs.writeFileSync(path.join(deep, `generated-output-file-${String(index).padStart(6, '0')}.json`), '{}');

  const saved = await recordCheckpoint({ directory: root, sessionId: SESSION });
  const files = git(root, 'ls-tree', '-r', '--name-only', saved.refs[0]).split('\n');

  assert.ok(UNTRACKED_FILE_COUNT_LIMIT < 22_000);
  assert.equal(git(root, 'show', `${saved.refs[0]}:lead.ts`), 'export const kept = 9;');
  assert.equal(files.some((file) => file.startsWith('generated/')), false);
  assert.equal(saved.newFiles.overCap, true);
  assert.match(checkpointLine(saved.refs, saved.newFiles), /New files were not saved/);
});

test('a session\'s checkpoints can be removed without touching other sessions', async () => {
  const root = repository();
  fs.writeFileSync(path.join(root, 'lead.ts'), 'changed\n');
  await recordCheckpoint({ directory: root, sessionId: SESSION });
  await recordCheckpoint({ directory: root, sessionId: 'ses_other' });

  await removeCheckpoints({ directory: root, sessionId: SESSION });

  assert.deepEqual(refs(root), []);
  assert.deepEqual(git(root, 'for-each-ref', '--format=%(refname)', 'refs/mittrcraft/goal/').split('\n'), ['refs/mittrcraft/goal/ses_other/1']);
});

test('the sweep deletes checkpoints older than 14 days and keeps newer ones', async () => {
  const root = repository();
  const old = execFileSync('git', ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'goal checkpoint'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test', GIT_COMMITTER_DATE: '2026-11-01T00:00:00Z' },
  }).trim();
  git(root, 'update-ref', 'refs/mittrcraft/goal/ses_old/1', old);
  fs.writeFileSync(path.join(root, 'lead.ts'), 'recent\n');
  await recordCheckpoint({ directory: root, sessionId: SESSION });

  await sweepCheckpoints({ directory: root, now: Date.parse('2026-11-26T00:00:00Z') });

  assert.deepEqual(git(root, 'for-each-ref', '--format=%(refname)', 'refs/mittrcraft/goal/').split('\n'), [`refs/mittrcraft/goal/${SESSION}/1`]);
});

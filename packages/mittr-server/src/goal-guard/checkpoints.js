import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CHECKPOINT_KEEP = 20;
export const UNTRACKED_FILE_LIMIT_BYTES = 5 * 1024 * 1024;
export const UNTRACKED_FILE_COUNT_LIMIT = 2_000;
const UNTRACKED_TOTAL_LIMIT_BYTES = 50 * 1024 * 1024;
const CHECKPOINT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const CHECKPOINT_REF_ROOT = 'refs/mittrcraft/goal';
const CHECKPOINTS_SHOWN = 3;
const GIT_TIMEOUT_MS = 10_000;
const GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;
const SECRET_LOOKING = /^\.env(\..*)?$|\.(pem|key|p12|pfx|jks|keystore)$|^id_(rsa|dsa|ecdsa|ed25519)|credential|secret|^\.(netrc|npmrc|pgpass)$/i;

const CHECKPOINT_IDENTITY = {
  GIT_AUTHOR_NAME: 'MittrCraft checkpoint',
  GIT_AUTHOR_EMAIL: 'checkpoint@mittrcraft.invalid',
  GIT_COMMITTER_NAME: 'MittrCraft checkpoint',
  GIT_COMMITTER_EMAIL: 'checkpoint@mittrcraft.invalid',
};

const gitOutput = (directory, args, env = {}) => new Promise((resolve, reject) => {
  execFile('git', args, {
    cwd: directory,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_OUTPUT_BYTES,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...env },
  }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

const runGit = async (directory, args, env) => (await gitOutput(directory, args, env)).trim();

const gitOrNull = (directory, args) => runGit(directory, args).catch(() => null);

const isWorkTree = async (directory) => Boolean(directory) && await gitOrNull(directory, ['rev-parse', '--is-inside-work-tree']) === 'true';

const checkpointRef = (sessionId, n) => `${CHECKPOINT_REF_ROOT}/${sessionId}/${n}`;

const listCheckpoints = async (directory, sessionId) => {
  const listed = await runGit(directory, ['for-each-ref', '--format=%(refname) %(objectname)', `${CHECKPOINT_REF_ROOT}/${sessionId}/`]);
  return listed.split('\n').filter(Boolean)
    .map((line) => {
      const [ref, sha] = line.split(' ');
      return { ref, sha, n: Number(ref.slice(ref.lastIndexOf('/') + 1)) };
    })
    .filter((checkpoint) => Number.isSafeInteger(checkpoint.n) && checkpoint.n > 0)
    .sort((a, b) => b.n - a.n);
};

const deleteRefs = async (directory, entries) => {
  for (const { ref, sha } of entries) await runGit(directory, ['update-ref', '-d', ref, sha]);
};

const newFilesWithin = async (top) => {
  const listed = (await gitOutput(top, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter((file) => file && !file.endsWith('/'));
  const found = { kept: [], large: 0, secret: 0, overCap: false };
  let bytes = 0;
  for (const file of listed) {
    if (SECRET_LOOKING.test(path.basename(file))) {
      found.secret += 1;
      continue;
    }
    if (found.overCap) continue;
    const stat = await fs.lstat(path.join(top, file)).catch(() => null);
    if (!stat) continue;
    if (stat.isFile() && stat.size > UNTRACKED_FILE_LIMIT_BYTES) {
      found.large += 1;
      continue;
    }
    found.kept.push(file);
    bytes += stat.isFile() ? stat.size : 0;
    if (found.kept.length > UNTRACKED_FILE_COUNT_LIMIT || bytes > UNTRACKED_TOTAL_LIMIT_BYTES) found.overCap = true;
  }
  if (found.overCap) found.kept = [];
  return found;
};

const stillThere = async (top, files) => {
  const present = await Promise.all(files.map((file) => fs.lstat(path.join(top, file)).then(() => true, () => false)));
  return files.filter((_file, index) => present[index]);
};

const addNewFiles = async ({ top, scratch, env, files }) => {
  const pathspec = path.join(scratch, 'pathspec');
  const add = async (list) => {
    if (list.length === 0) return 0;
    await fs.writeFile(pathspec, `${list.join('\0')}\0`);
    await runGit(top, ['add', `--pathspec-from-file=${pathspec}`, '--pathspec-file-nul'], { ...env, GIT_LITERAL_PATHSPECS: '1' });
    return list.length;
  };
  return add(files).catch(async () => add(await stillThere(top, files)));
};

const copyIndex = async (index, copy) => {
  const stat = await fs.stat(index).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
    return null;
  });
  await fs.rm(copy, { force: true });
  if (!stat) return;
  await fs.copyFile(index, copy);
  await fs.utimes(copy, stat.atime, stat.mtime);
};

const stashLeavingIndexAlone = async (directory) => {
  const index = path.resolve(directory, await runGit(directory, ['rev-parse', '--git-path', 'index']));
  const top = await runGit(directory, ['rev-parse', '--show-toplevel']);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'mittrcraft-checkpoint-'));
  try {
    const copy = path.join(scratch, 'index');
    await copyIndex(index, copy);
    const env = { ...CHECKPOINT_IDENTITY, GIT_INDEX_FILE: copy };
    const found = await newFilesWithin(top);
    const newFiles = { saved: 0, large: found.large, secret: found.secret, overCap: found.overCap, failed: false };
    if (found.kept.length > 0) {
      try {
        newFiles.saved = await addNewFiles({ top, scratch, env, files: found.kept });
      } catch {
        newFiles.failed = true;
        await copyIndex(index, copy);
      }
    }
    return { stash: await runGit(directory, ['stash', 'create', 'goal checkpoint'], env), newFiles };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
};

export const recordCheckpoint = async ({ directory, sessionId, keep = CHECKPOINT_KEEP }) => {
  if (!SAFE_SESSION_ID.test(sessionId) || !await isWorkTree(directory)) return null;
  const head = await gitOrNull(directory, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (!head) return null;

  const { stash, newFiles } = await stashLeavingIndexAlone(directory);
  const tree = await runGit(directory, ['rev-parse', `${stash || head}^{tree}`]);
  let checkpoints = await listCheckpoints(directory, sessionId);
  if (stash) {
    const newest = checkpoints[0];
    const newestTree = newest ? await gitOrNull(directory, ['rev-parse', `${newest.sha}^{tree}`]) : null;
    if (newestTree !== tree) {
      const ref = checkpointRef(sessionId, (newest?.n ?? 0) + 1);
      await runGit(directory, ['update-ref', ref, stash, '']);
      checkpoints = [{ ref, sha: stash }, ...checkpoints];
    }
  }
  await deleteRefs(directory, checkpoints.slice(keep));
  return { head, tree, refs: checkpoints.slice(0, keep).map((checkpoint) => checkpoint.ref), newFiles };
};

export const removeCheckpoints = async ({ directory, sessionId }) => {
  if (!SAFE_SESSION_ID.test(sessionId) || !await isWorkTree(directory)) return;
  await deleteRefs(directory, await listCheckpoints(directory, sessionId));
};

export const sweepCheckpoints = async ({ directory, now = Date.now() }) => {
  if (!await isWorkTree(directory)) return;
  const listed = await runGit(directory, ['for-each-ref', '--format=%(refname) %(objectname) %(committerdate:unix)', `${CHECKPOINT_REF_ROOT}/`]);
  const old = listed.split('\n').filter(Boolean)
    .map((line) => {
      const [ref, sha, seconds] = line.split(' ');
      return { ref, sha, at: Number(seconds) * 1000 };
    })
    .filter((entry) => Number.isFinite(entry.at) && now - entry.at > CHECKPOINT_MAX_AGE_MS);
  await deleteRefs(directory, old);
};

const plural = (count, one, many) => (count === 1 ? `1 ${one}` : `${count} ${many}`);

const newFilesNote = (newFiles) => {
  if (!newFiles) return '';
  if (newFiles.overCap) return ` New files were not saved: there are more than ${UNTRACKED_FILE_COUNT_LIMIT.toLocaleString('en')} of them or over 50 MB together.`;
  if (newFiles.failed) return ' New files could not be added this time and were not saved.';
  const parts = [];
  if (newFiles.large) parts.push(plural(newFiles.large, 'new file over 5 MB', 'new files over 5 MB'));
  if (newFiles.secret) parts.push(plural(newFiles.secret, 'secret-looking new file', 'secret-looking new files'));
  return parts.length > 0 ? ` Left out: ${parts.join(', ')}.` : '';
};

export const checkpointLine = (refs, newFiles) => {
  if (refs.length === 0) return '';
  return `Earlier uncommitted work in this folder is saved in git checkpoints, newest first: ${refs.slice(0, CHECKPOINTS_SHOWN).join(', ')}. If work you need is no longer in the files, check a checkpoint with \`git stash show -p <checkpoint>\` and restore it with \`git stash apply <checkpoint>\` instead of redoing it; do not discard work you cannot get back.${newFilesNote(newFiles)}`;
};

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * A one-time copy of every folder the first OpenCode 2 start may change. Going
 * back to 1.x after that start is a restore from these copies, not a
 * downgrade: OpenCode 2 migrates the session database in place.
 *
 * Each existing folder is copied to `<folder>.pre-2x-backup.partial` and
 * renamed to `<folder>.pre-2x-backup` once complete, then the marker is
 * written. A finished backup is never removed or replaced: if the marker is
 * lost later, the copy already there is the pristine one and is kept. Only a
 * `.partial` copy, left by a start that failed, is ever removed.
 */

const BACKUP_SUFFIX = '.pre-2x-backup';
const PARTIAL_SUFFIX = `${BACKUP_SUFFIX}.partial`;

const exists = async (target) => {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

// Anything at all at the path, a dangling link included, counts as taken.
const isTaken = async (target) => {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

const removePartial = (partial) => {
  if (!partial.endsWith(PARTIAL_SUFFIX)) throw new Error(`Refusing to remove ${partial}: not a partial backup`);
  return fs.rm(partial, { recursive: true, force: true });
};

const isInside = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

// A folder inside another listed folder travels with that folder's copy. The
// Dev build keeps the whole engine inside its data dir, and prod keeps the
// engine config there.
const outermost = (dirs) => {
  const unique = [...new Set(dirs.map((dir) => path.resolve(dir)))];
  return unique.filter((dir) => !unique.some((other) => isInside(dir, other)));
};

// A socket or pipe cannot be copied and holds no data; an older backup is not
// part of the folder it sits in.
const isCopyable = async (source) => {
  if (source.endsWith(BACKUP_SUFFIX) || source.endsWith(PARTIAL_SUFFIX)) return false;
  const stat = await fs.lstat(source);
  return stat.isFile() || stat.isDirectory() || stat.isSymbolicLink();
};

const copyOne = async (dir, target, excluded) => {
  const partial = `${dir}${PARTIAL_SUFFIX}`;
  try {
    await removePartial(partial);
    const source = await fs.realpath(dir);
    const skip = new Set(
      excluded.filter((entry) => isInside(entry, dir)).map((entry) => path.join(source, path.relative(dir, entry))),
    );
    await fs.cp(source, partial, {
      recursive: true,
      preserveTimestamps: true,
      errorOnExist: true,
      force: false,
      filter: async (entry) => !skip.has(entry) && isCopyable(entry),
    });
    await fs.rename(partial, target);
  } catch (error) {
    await removePartial(partial).catch(() => {});
    throw new Error(`Could not back up ${dir} to ${target}: ${error?.message ?? error}`, { cause: error });
  }
};

/**
 * Copies each existing folder in `dirs` once, leaving out the paths in
 * `exclude`. Resolves `{ made: true, where, kept }`: the copies it made and the
 * finished copies it found and left alone. Once the marker exists it resolves
 * `{ made: false, where: [], kept: [] }`. Rejects without writing the marker
 * if any copy fails; the next start keeps what finished and copies the rest.
 */
export const backupOnce = async ({ dirs, marker, exclude = [] }) => {
  if (await exists(marker)) return { made: false, where: [], kept: [] };

  const excluded = exclude.map((entry) => path.resolve(entry));
  const where = [];
  const kept = [];
  for (const dir of outermost(dirs)) {
    if (!(await exists(dir))) continue;
    const target = `${dir}${BACKUP_SUFFIX}`;
    if (await isTaken(target)) {
      kept.push(target);
      continue;
    }
    await copyOne(dir, target, excluded);
    where.push(target);
  }

  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, `${JSON.stringify({ at: new Date().toISOString(), where, kept }, null, 2)}\n`);
  return { made: true, where, kept };
};

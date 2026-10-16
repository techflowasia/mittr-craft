import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * A one-time copy of every folder the first OpenCode 2 start may change. Going
 * back to 1.x after that start is a restore from these copies, not a
 * downgrade: OpenCode 2 migrates the session database in place.
 *
 * Each existing folder is copied whole to `<folder>.pre-2x-backup`, then the
 * marker is written. Until the marker exists every start tries again, so a
 * failed copy never counts as a backup.
 */

const BACKUP_SUFFIX = '.pre-2x-backup';

const exists = async (target) => {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
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
  if (source.endsWith(BACKUP_SUFFIX)) return false;
  const stat = await fs.lstat(source);
  return stat.isFile() || stat.isDirectory() || stat.isSymbolicLink();
};

const copyOne = async (dir, excluded) => {
  const target = `${dir}${BACKUP_SUFFIX}`;
  try {
    // Only a target this function names is ever removed: a partial copy left
    // by a start that failed before writing the marker.
    await fs.rm(target, { recursive: true, force: true });
    const source = await fs.realpath(dir);
    const skip = new Set(
      excluded.filter((entry) => isInside(entry, dir)).map((entry) => path.join(source, path.relative(dir, entry))),
    );
    await fs.cp(source, target, {
      recursive: true,
      preserveTimestamps: true,
      errorOnExist: true,
      force: false,
      filter: async (entry) => !skip.has(entry) && isCopyable(entry),
    });
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Could not back up ${dir} to ${target}: ${error?.message ?? error}`, { cause: error });
  }
  return target;
};

/**
 * Copies each existing folder in `dirs` once, leaving out the paths in
 * `exclude`. Resolves `{ made: true, where }` with the copies it made, or
 * `{ made: false, where: [] }` once the marker exists. Rejects without writing
 * the marker if any copy fails.
 */
export const backupOnce = async ({ dirs, marker, exclude = [] }) => {
  if (await exists(marker)) return { made: false, where: [] };

  const excluded = exclude.map((entry) => path.resolve(entry));
  const where = [];
  for (const dir of outermost(dirs)) {
    if (!(await exists(dir))) continue;
    where.push(await copyOne(dir, excluded));
  }

  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, `${JSON.stringify({ at: new Date().toISOString(), where }, null, 2)}\n`);
  return { made: true, where };
};

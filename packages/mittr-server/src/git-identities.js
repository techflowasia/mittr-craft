import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Upstream keeps git identities in `<dataDir>/git-identities.json`. While that
 * file is missing, its first read takes a lock in `~/.config/openchamber` and
 * copies a real OpenChamber's identities from there. Creating the file at
 * setup keeps upstream away from that folder.
 *
 * MittrCraft 1.22, Dev included, kept identities in
 * `~/.config/mittrcraft/git-identities.json`. A data dir without its own file
 * starts from that one, and from an empty store when there is none.
 */

const FILE_NAME = 'git-identities.json';
const MAX_PROFILES = 256;

const isPlainObject = (value) => value != null && Object.getPrototypeOf(value) === Object.prototype;
const nonEmpty = (value) => typeof value === 'string' && value.length > 0;

export const legacyGitIdentitiesFile = (homeDir) => path.join(homeDir, '.config', 'mittrcraft', FILE_NAME);

// The profiles of a 1.22 store in the shape upstream accepts, or null.
const profilesOf = (parsed) => {
  if (!isPlainObject(parsed) || !Array.isArray(parsed.profiles) || parsed.profiles.length > MAX_PROFILES) return null;
  const ids = new Set();
  for (const profile of parsed.profiles) {
    if (!isPlainObject(profile) || !nonEmpty(profile.id) || !nonEmpty(profile.userName) || !nonEmpty(profile.userEmail)) return null;
    if (ids.has(profile.id)) return null;
    ids.add(profile.id);
  }
  return parsed.profiles;
};

const readLegacyProfiles = async (file) => {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { profiles: null, problem: null };
    return { profiles: null, problem: error?.message ?? String(error) };
  }
  try {
    const profiles = profilesOf(JSON.parse(raw));
    return profiles ? { profiles, problem: null } : { profiles: null, problem: 'not a git identity store' };
  } catch (error) {
    return { profiles: null, problem: error.message };
  }
};

/**
 * Creates `<dataDir>/git-identities.json` when it is missing. Never replaces
 * an existing file: the new file is linked into place, which fails when one
 * appeared meanwhile.
 */
export const ensureGitIdentityStore = async ({ dataDir, homeDir, logger }) => {
  const target = path.join(dataDir, FILE_NAME);
  try {
    await fs.lstat(target);
    return { created: false, seededFrom: null };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const legacy = legacyGitIdentitiesFile(homeDir);
  let profiles = [];
  let seededFrom = null;
  if (path.resolve(legacy) !== path.resolve(target)) {
    const read = await readLegacyProfiles(legacy);
    if (read.profiles) {
      profiles = read.profiles;
      seededFrom = legacy;
    } else if (read.problem) {
      logger?.warn?.(`[mittr] did not copy git identities from ${legacy}: ${read.problem}`);
    }
  }

  await fs.mkdir(dataDir, { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify({ profiles }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.chmod(temporary, 0o600);
    try {
      await fs.link(temporary, target);
    } catch (error) {
      if (error?.code === 'EEXIST') return { created: false, seededFrom: null };
      throw error;
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return { created: true, seededFrom };
};

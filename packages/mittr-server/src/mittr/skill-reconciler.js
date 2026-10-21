import { randomBytes } from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';

import { writePrivateAtomic } from './private-file.js';
import { isRecord } from './values.js';

const ORG_PREFIX = 'mittr-';
const VERSION_FILE = '.mittr-version';
const ACCOUNT_FILE = '.mittr-account';
const STAGING_PREFIX = '.mittr-staging-';
const ASIDE_PREFIX = '.mittr-old-';
const WORK_DIR = '.mittr-skills-work';
const LEGACY_ORG_DIR = 'mittr';
const SKILL_FILE = 'SKILL.md';
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TEXT_FILE = /\.(md|txt|json|ya?ml)$/i;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/;
const NAME_LINE = /^name[ \t]*:.*$/m;
const NOT_FROM_CATALOG = 'a skill folder of that name is already there and is not from the Mittr catalog';
const FOREIGN_STUCK = 'another account\'s catalog skill could not be removed, so this account\'s set is not marked as installed';
const EMPTY_COLLECTION = { configured: false, items: [] };

export const skillIdOf = (name) => `${ORG_PREFIX}${name}`;

const safeRelativePath = (value) => {
  if (typeof value !== 'string' || !value || /[\\\0:]/.test(value)) return null;
  if (path.posix.normalize(value) !== value || value.startsWith('/')) return null;
  if (value.split('/').some((part) => part.startsWith('.'))) return null;
  return TEXT_FILE.test(value) ? value : null;
};

export function parseCatalogSkill(item) {
  if (!isRecord(item)) return null;
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  const version = typeof item.version === 'string' ? item.version.trim() : '';
  if (!NAME.test(name) || !version || !Array.isArray(item.files)) return null;
  const files = [];
  for (const file of item.files) {
    const filePath = safeRelativePath(file?.path);
    if (!filePath || typeof file.content !== 'string') return null;
    files.push({ path: filePath, content: file.content });
  }
  if (!files.some((file) => file.path === SKILL_FILE)) return null;
  if (files.some((file) => file.path !== SKILL_FILE && path.posix.basename(file.path).toLowerCase() === SKILL_FILE.toLowerCase())) return null;
  if (new Set(files.map((file) => file.path.toLowerCase())).size !== files.length) return null;
  return { name, version, files };
}

const withFolderName = (content, id) => {
  const frontmatter = FRONTMATTER.exec(content)?.[0];
  if (!frontmatter || !NAME_LINE.test(frontmatter)) return content;
  return frontmatter.replace(NAME_LINE, `name: ${id}`) + content.slice(frontmatter.length);
};

const errorText = (error) => (error instanceof Error ? error.message : String(error));

const listFolder = (fs, root) => {
  try {
    return fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
};

const isRegularFile = (fs, filePath) => {
  try {
    return fs.lstatSync(filePath).isFile();
  } catch {
    return false;
  }
};

const readText = (fs, filePath) => {
  if (!isRegularFile(fs, filePath)) return null;
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
};

const holdsVersion = (fs, dir, entry) => entry.isDirectory() && isRegularFile(fs, path.join(dir, entry.name, VERSION_FILE));

const isOrgSkill = (fs, root, entry) => entry.name.startsWith(ORG_PREFIX) && holdsVersion(fs, root, entry);

const tryRemove = (fs, target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    return false;
  }
  return true;
};

const sameDevice = (fs, a, b) => {
  try {
    return fs.statSync(a).dev === fs.statSync(b).dev;
  } catch {
    return false;
  }
};

const stagingDirFor = (fs, root, work) => {
  try {
    fs.mkdirSync(work, { recursive: true });
  } catch {
    return root;
  }
  return sameDevice(fs, work, root) ? work : root;
};

const removeLegacyOrgSkills = (fs, root, result) => {
  const legacy = path.join(root, LEGACY_ORG_DIR);
  let isDir = false;
  try {
    isDir = fs.lstatSync(legacy).isDirectory();
  } catch {
    return;
  }
  if (!isDir) return;
  for (const entry of listFolder(fs, legacy).filter((candidate) => holdsVersion(fs, legacy, candidate))) {
    const id = `${LEGACY_ORG_DIR}/${entry.name}`;
    if (tryRemove(fs, path.join(legacy, entry.name))) result.removed.push(id);
    else result.failed.push({ name: id, error: 'a 1.22 catalog skill could not be removed' });
  }
  if (listFolder(fs, legacy).length === 0) tryRemove(fs, legacy);
};

const isLeftover = (entry) => entry.isDirectory()
  && (entry.name.startsWith(STAGING_PREFIX) || entry.name.startsWith(ASIDE_PREFIX));

const writeSkill = (fs, root, work, id, skill, replacing) => {
  fs.mkdirSync(root, { recursive: true });
  const stagingDir = stagingDirFor(fs, root, work);
  const staging = fs.mkdtempSync(path.join(stagingDir, `${STAGING_PREFIX}${id}-`));
  const destination = path.join(root, id);
  try {
    for (const file of skill.files) {
      const target = path.join(staging, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.path === SKILL_FILE ? withFolderName(file.content, id) : file.content, 'utf8');
    }
    fs.writeFileSync(path.join(staging, VERSION_FILE), `${skill.version}\n`, 'utf8');
    if (!replacing) {
      fs.renameSync(staging, destination);
      return;
    }
    const aside = path.join(stagingDir, `${ASIDE_PREFIX}${id}-${randomBytes(4).toString('hex')}`);
    fs.renameSync(destination, aside);
    try {
      fs.renameSync(staging, destination);
    } catch (error) {
      fs.renameSync(aside, destination);
      throw error;
    }
    tryRemove(fs, aside);
  } finally {
    tryRemove(fs, staging);
  }
};

const wantedSkills = (collection, enablement) => {
  const wanted = new Map();
  for (const item of collection.items) {
    const skill = parseCatalogSkill(item);
    if (!skill || wanted.has(skillIdOf(skill.name))) continue;
    if (!enablement.isEnabled('skills', skill.name)) continue;
    wanted.set(skillIdOf(skill.name), skill);
  }
  return wanted;
};

export function reconcileSkills({ catalog, enablement, skillsRoot: root, accountKey, fs = nodeFs }) {
  const result = { installed: [], updated: [], removed: [], failed: [] };
  if (!root) return result;
  const key = typeof accountKey === 'string' && accountKey ? accountKey : null;
  const work = path.join(path.dirname(root), WORK_DIR);
  tryRemove(fs, work);

  const entries = listFolder(fs, root);
  entries.filter(isLeftover).forEach((entry) => tryRemove(fs, path.join(root, entry.name)));
  removeLegacyOrgSkills(fs, root, result);
  const owned = new Set(entries.filter((entry) => isOrgSkill(fs, root, entry)).map((entry) => entry.name));
  const taken = new Set(entries.map((entry) => entry.name));
  const markerPath = path.join(root, ACCOUNT_FILE);
  const marker = readText(fs, markerPath);

  const remove = (id, failure = (error) => errorText(error)) => {
    try {
      fs.rmSync(path.join(root, id), { recursive: true, force: true });
      owned.delete(id);
      taken.delete(id);
      result.removed.push(id);
    } catch (error) {
      result.failed.push({ name: id, error: failure(error) });
    }
  };

  const sameAccount = key !== null && marker === key;
  if (!sameAccount) [...owned].sort().forEach((id) => remove(id, (error) => `${FOREIGN_STUCK}: ${errorText(error)}`));
  const foreignLeft = new Set(sameAccount ? [] : owned);

  const collection = isRecord(catalog) && isRecord(catalog.skills) && Array.isArray(catalog.skills.items) ? catalog.skills : EMPTY_COLLECTION;
  if (key !== null && collection.configured === true) {
    const wanted = wantedSkills(collection, enablement);
    [...owned].filter((id) => !wanted.has(id) && !foreignLeft.has(id)).sort().forEach((id) => remove(id));
    for (const [id, skill] of wanted) {
      if (foreignLeft.has(id)) continue;
      const replacing = owned.has(id);
      if (!replacing && taken.has(id)) {
        result.failed.push({ name: id, error: NOT_FROM_CATALOG });
        continue;
      }
      if (replacing && readText(fs, path.join(root, id, VERSION_FILE)) === skill.version) continue;
      try {
        writeSkill(fs, root, work, id, skill, replacing);
        owned.add(id);
        (replacing ? result.updated : result.installed).push(id);
      } catch (error) {
        result.failed.push({ name: id, error: errorText(error) });
      }
    }
  }

  tryRemove(fs, work);
  if (key !== null && owned.size > 0 && foreignLeft.size === 0) {
    if (marker !== key) writePrivateAtomic(markerPath, `${key}\n`, { fs });
  } else if (marker !== null) {
    fs.rmSync(markerPath, { force: true });
  }
  return result;
}

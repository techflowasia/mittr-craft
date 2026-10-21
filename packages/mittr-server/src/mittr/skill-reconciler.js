import { randomBytes } from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';

import { isRecord } from './values.js';

const ORG_PREFIX = 'mittr-';
const VERSION_FILE = '.mittr-version';
const ACCOUNT_FILE = '.mittr-account';
const STAGING_PREFIX = '.mittr-staging-';
const ASIDE_PREFIX = '.mittr-old-';
const SKILL_FILE = 'SKILL.md';
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TEXT_FILE = /\.(md|txt|json|ya?ml)$/i;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/;
const NAME_LINE = /^name[ \t]*:.*$/m;
const NOT_FROM_CATALOG = 'a skill folder of that name is already there and is not from the Mittr catalog';
const EMPTY_COLLECTION = { configured: false, items: [] };

export const skillIdOf = (name) => `${ORG_PREFIX}${name}`;

const safeRelativePath = (value) => {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) return null;
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

const readText = (fs, filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
};

const isOrgSkill = (fs, root, entry) => {
  if (!entry.isDirectory() || !entry.name.startsWith(ORG_PREFIX)) return false;
  try {
    return fs.lstatSync(path.join(root, entry.name, VERSION_FILE)).isFile();
  } catch {
    return false;
  }
};

const tryRemove = (fs, target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    return;
  }
};

const isLeftover = (entry) => entry.isDirectory()
  && (entry.name.startsWith(STAGING_PREFIX) || entry.name.startsWith(ASIDE_PREFIX));

const writeSkill = (fs, root, id, skill, replacing) => {
  fs.mkdirSync(root, { recursive: true });
  const staging = fs.mkdtempSync(path.join(root, `${STAGING_PREFIX}${id}-`));
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
    const aside = path.join(root, `${ASIDE_PREFIX}${id}-${randomBytes(4).toString('hex')}`);
    fs.renameSync(destination, aside);
    try {
      fs.renameSync(staging, destination);
    } catch (error) {
      fs.renameSync(aside, destination);
      throw error;
    }
    fs.rmSync(aside, { recursive: true, force: true });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
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

  const entries = listFolder(fs, root);
  entries.filter(isLeftover).forEach((entry) => tryRemove(fs, path.join(root, entry.name)));
  const owned = new Set(entries.filter((entry) => isOrgSkill(fs, root, entry)).map((entry) => entry.name));
  const taken = new Set(entries.map((entry) => entry.name));
  const markerPath = path.join(root, ACCOUNT_FILE);
  const marker = readText(fs, markerPath);

  const remove = (id) => {
    try {
      fs.rmSync(path.join(root, id), { recursive: true, force: true });
      owned.delete(id);
      taken.delete(id);
      result.removed.push(id);
    } catch (error) {
      result.failed.push({ name: id, error: errorText(error) });
    }
  };

  const sameAccount = key !== null && marker === key;
  if (!sameAccount) [...owned].sort().forEach(remove);
  const foreignLeft = new Set(sameAccount ? [] : owned);

  const collection = isRecord(catalog) && isRecord(catalog.skills) && Array.isArray(catalog.skills.items) ? catalog.skills : EMPTY_COLLECTION;
  if (key !== null && collection.configured === true) {
    const wanted = wantedSkills(collection, enablement);
    [...owned].filter((id) => !wanted.has(id) && !foreignLeft.has(id)).sort().forEach(remove);
    for (const [id, skill] of wanted) {
      if (foreignLeft.has(id)) continue;
      const replacing = owned.has(id);
      if (!replacing && taken.has(id)) {
        result.failed.push({ name: id, error: NOT_FROM_CATALOG });
        continue;
      }
      if (replacing && readText(fs, path.join(root, id, VERSION_FILE)) === skill.version) continue;
      try {
        writeSkill(fs, root, id, skill, replacing);
        owned.add(id);
        (replacing ? result.updated : result.installed).push(id);
      } catch (error) {
        result.failed.push({ name: id, error: errorText(error) });
      }
    }
  }

  if (key !== null && owned.size > 0 && foreignLeft.size === 0) {
    if (marker !== key) fs.writeFileSync(markerPath, `${key}\n`, 'utf8');
  } else if (marker !== null) {
    fs.rmSync(markerPath, { force: true });
  }
  return result;
}

import fs from 'node:fs';
import path from 'node:path';

const ORG_SKILLS_DIR = 'mittr';
const VERSION_FILE = '.mittr-version';
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TEXT_FILE = /\.(md|txt|json|ya?ml)$/i;

const safeRelativePath = (value) => {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) return null;
  const normalized = path.posix.normalize(value);
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) return null;
  if (normalized.split('/').some((part) => part.startsWith('.'))) return null;
  if (!TEXT_FILE.test(normalized)) return null;
  return normalized;
};

export function parseCatalogSkill(item) {
  if (!item || typeof item !== 'object') return null;
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  const version = typeof item.version === 'string' ? item.version.trim() : '';
  if (!NAME.test(name) || !version || !Array.isArray(item.files)) return null;
  const files = [];
  for (const file of item.files) {
    const filePath = safeRelativePath(file?.path);
    if (!filePath || typeof file.content !== 'string') return null;
    files.push({ path: filePath, content: file.content });
  }
  if (!files.some((file) => file.path === 'SKILL.md')) return null;
  return { name, version, files };
}

const installedVersion = (skillDir) => {
  try {
    return fs.readFileSync(path.join(skillDir, VERSION_FILE), 'utf8').trim();
  } catch {
    return null;
  }
};

const writeSkill = (orgDir, skill) => {
  const staging = fs.mkdtempSync(path.join(orgDir, `.staging-${skill.name}-`));
  try {
    for (const file of skill.files) {
      const target = path.join(staging, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content, 'utf8');
    }
    fs.writeFileSync(path.join(staging, VERSION_FILE), `${skill.version}\n`, 'utf8');
    const destination = path.join(orgDir, skill.name);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(staging, destination);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
};

export function reconcileSkills({ catalog, enablement, skillsRoot }) {
  const result = { installed: [], updated: [], removed: [], failed: [] };
  const collection = catalog?.skills ?? { configured: false, items: [] };
  if (!collection.configured || !skillsRoot) return result;

  const orgDir = path.join(skillsRoot, ORG_SKILLS_DIR);
  fs.mkdirSync(orgDir, { recursive: true });

  const wanted = new Map();
  for (const item of collection.items) {
    const skill = parseCatalogSkill(item);
    if (!skill || wanted.has(skill.name)) continue;
    if (!enablement.isEnabled('skills', skill.name)) continue;
    wanted.set(skill.name, skill);
  }

  for (const skill of wanted.values()) {
    const skillDir = path.join(orgDir, skill.name);
    const present = installedVersion(skillDir);
    if (present === skill.version) continue;
    try {
      writeSkill(orgDir, skill);
      (present === null ? result.installed : result.updated).push(skill.name);
    } catch (error) {
      result.failed.push({ name: skill.name, error: error instanceof Error ? error.message : String(error) });
    }
  }

  for (const entry of fs.readdirSync(orgDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.staging-') || !wanted.has(entry.name)) {
      fs.rmSync(path.join(orgDir, entry.name), { recursive: true, force: true });
      if (!entry.name.startsWith('.staging-')) result.removed.push(entry.name);
    }
  }

  return result;
}

export const skillsChanged = (result) =>
  result.installed.length > 0 || result.updated.length > 0 || result.removed.length > 0;

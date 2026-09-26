import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCatalogSkill, reconcileSkills, skillsChanged } from './skill-reconciler.js';

const roots = [];
const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-skills-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const enabled = { isEnabled: () => true };
const catalogWith = (items) => ({ skills: { configured: true, items } });
const craft = (version = 'v1', chapter = 'explore first') => ({
  name: 'code-craft',
  description: 'How a senior engineer changes code.',
  version,
  source: 'mittr-system',
  files: [
    { path: 'SKILL.md', content: '---\nname: code-craft\ndescription: x\n---\n' },
    { path: 'references/exploring.md', content: chapter },
  ],
});
const read = (root, ...parts) => fs.readFileSync(path.join(root, 'mittr', ...parts), 'utf8');

describe('reconcileSkills', () => {
  it('installs an offered skill under the organisation folder with every file', () => {
    const root = makeRoot();
    const result = reconcileSkills({ catalog: catalogWith([craft()]), enablement: enabled, skillsRoot: root });
    expect(result.installed).toEqual(['code-craft']);
    expect(read(root, 'code-craft', 'SKILL.md')).toContain('name: code-craft');
    expect(read(root, 'code-craft', 'references', 'exploring.md')).toBe('explore first');
    expect(skillsChanged(result)).toBe(true);
  });

  it('writes nothing when the installed version is already current', () => {
    const root = makeRoot();
    reconcileSkills({ catalog: catalogWith([craft()]), enablement: enabled, skillsRoot: root });
    const again = reconcileSkills({ catalog: catalogWith([craft()]), enablement: enabled, skillsRoot: root });
    expect(skillsChanged(again)).toBe(false);
  });

  it('replaces the whole skill when its version changes, dropping files it no longer ships', () => {
    const root = makeRoot();
    reconcileSkills({ catalog: catalogWith([craft('v1')]), enablement: enabled, skillsRoot: root });
    const next = { ...craft('v2', 'map the impact'), files: craft('v2', 'map the impact').files.slice(0, 1) };
    const result = reconcileSkills({ catalog: catalogWith([next]), enablement: enabled, skillsRoot: root });
    expect(result.updated).toEqual(['code-craft']);
    expect(fs.existsSync(path.join(root, 'mittr', 'code-craft', 'references', 'exploring.md'))).toBe(false);
  });

  it('removes an organisation skill the catalog no longer offers', () => {
    const root = makeRoot();
    reconcileSkills({ catalog: catalogWith([craft()]), enablement: enabled, skillsRoot: root });
    const result = reconcileSkills({ catalog: catalogWith([]), enablement: enabled, skillsRoot: root });
    expect(result.removed).toEqual(['code-craft']);
    expect(fs.existsSync(path.join(root, 'mittr', 'code-craft'))).toBe(false);
  });

  it('removes a skill the developer switched off', () => {
    const root = makeRoot();
    reconcileSkills({ catalog: catalogWith([craft()]), enablement: enabled, skillsRoot: root });
    const off = { isEnabled: (kind, name) => !(kind === 'skills' && name === 'code-craft') };
    const result = reconcileSkills({ catalog: catalogWith([craft()]), enablement: off, skillsRoot: root });
    expect(result.removed).toEqual(['code-craft']);
  });

  it('leaves everything alone when the catalog never configured skills', () => {
    const root = makeRoot();
    reconcileSkills({ catalog: catalogWith([craft()]), enablement: enabled, skillsRoot: root });
    const result = reconcileSkills({ catalog: { skills: { configured: false, items: [] } }, enablement: enabled, skillsRoot: root });
    expect(skillsChanged(result)).toBe(false);
    expect(fs.existsSync(path.join(root, 'mittr', 'code-craft', 'SKILL.md'))).toBe(true);
  });

  it('never touches the developer\'s own skills beside the organisation folder', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'mine'), { recursive: true });
    fs.writeFileSync(path.join(root, 'mine', 'SKILL.md'), 'mine');
    reconcileSkills({ catalog: catalogWith([]), enablement: enabled, skillsRoot: root });
    expect(fs.readFileSync(path.join(root, 'mine', 'SKILL.md'), 'utf8')).toBe('mine');
  });
});

describe('parseCatalogSkill', () => {
  it.each([
    ['a path escaping the skill folder', '../../evil.md'],
    ['an absolute path', '/etc/passwd.md'],
    ['a hidden file', '.mittr-version.md'],
    ['a non-text file', 'run.sh'],
    ['a backslash path', 'references\\a.md'],
  ])('refuses %s', (_label, filePath) => {
    const item = craft();
    item.files = [...item.files, { path: filePath, content: 'x' }];
    expect(parseCatalogSkill(item)).toBeNull();
  });

  it('refuses a skill without SKILL.md or with a name the engine would ignore', () => {
    expect(parseCatalogSkill({ ...craft(), files: [{ path: 'a.md', content: 'x' }] })).toBeNull();
    expect(parseCatalogSkill({ ...craft(), name: 'Code Craft' })).toBeNull();
  });
});

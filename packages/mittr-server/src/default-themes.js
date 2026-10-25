import fs from 'node:fs';
import path from 'node:path';

import { writePrivateAtomic } from './mittr/private-file.js';
import { isPlainObject } from './mittr/values.js';
import dark from './themes/openchamber-dark.json' with { type: 'json' };
import light from './themes/openchamber-light.json' with { type: 'json' };

export const DEFAULT_THEME_MARK = 'mittrcraft-default';
export const DEFAULT_THEMES = Object.freeze([light, dark]);

const THEMES_DIR = 'themes';

const lstatOrNull = (target) => {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};

const readTheme = (file) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const idOf = (theme) => (isPlainObject(theme?.metadata) ? theme.metadata.id : undefined);
const isOurs = (theme) => isPlainObject(theme?.metadata) && theme.metadata.source === DEFAULT_THEME_MARK;

const claimsElsewhere = (dir, ownName) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return new Set();
    throw error;
  }
  const claimed = new Set();
  for (const entry of entries) {
    if (!entry.name.toLowerCase().endsWith('.json') || ownName.has(entry.name)) continue;
    const theme = readTheme(path.join(dir, entry.name));
    if (theme && !isOurs(theme)) claimed.add(idOf(theme));
  }
  return claimed;
};

export const installDefaultThemes = ({ dataDir, logger = console }) => {
  const dir = path.join(dataDir, THEMES_DIR);
  const names = new Set(DEFAULT_THEMES.map((theme) => `${theme.metadata.id}.json`));
  const claimed = claimsElsewhere(dir, names);
  const outcome = {};
  for (const theme of DEFAULT_THEMES) {
    const { id } = theme.metadata;
    const file = path.join(dir, `${id}.json`);
    const text = `${JSON.stringify(theme, null, 2)}\n`;
    const stat = lstatOrNull(file);
    const present = stat ? readTheme(file) : null;
    if (stat && (!stat.isFile() || !isOurs(present))) {
      outcome[id] = 'theirs';
      continue;
    }
    if (claimed.has(id)) {
      if (stat) fs.rmSync(file);
      outcome[id] = 'theirs';
      continue;
    }
    if (stat && fs.readFileSync(file, 'utf8') === text) {
      outcome[id] = 'current';
      continue;
    }
    fs.mkdirSync(dir, { recursive: true });
    writePrivateAtomic(file, text);
    outcome[id] = stat ? 'updated' : 'written';
  }
  const changed = Object.entries(outcome).filter(([, result]) => result === 'written' || result === 'updated').map(([id]) => id);
  if (changed.length > 0) logger.log(`[mittr] default themes written: ${changed.join(', ')}`);
  return outcome;
};

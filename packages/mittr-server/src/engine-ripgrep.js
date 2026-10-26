import fs from 'node:fs';
import path from 'node:path';

const BUNDLED_RIPGREP_DIR = 'ripgrep';

export const bundledRipgrep = (resourcesDir) => {
  if (!resourcesDir) return null;
  const file = path.join(resourcesDir, BUNDLED_RIPGREP_DIR, 'rg');
  return fs.existsSync(file) ? file : null;
};

export const engineRipgrepPath = (bases) => path.join(bases.cache, 'opencode', 'bin', 'rg');

const sameCopy = (source, target) => {
  try {
    const copy = fs.statSync(target);
    return copy.size === source.size && Math.abs(copy.mtimeMs - source.mtimeMs) < 1;
  } catch {
    return false;
  }
};

export const placeEngineRipgrep = ({ bundled, bases }) => {
  if (!bundled) return null;
  const target = engineRipgrepPath(bases);
  const source = fs.statSync(bundled);
  if (sameCopy(source, target)) {
    if ((fs.statSync(target).mode & 0o777) !== 0o755) fs.chmodSync(target, 0o755);
    return target;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staged = `${target}.${process.pid}.partial`;
  try {
    fs.copyFileSync(bundled, staged);
    fs.chmodSync(staged, 0o755);
    fs.utimesSync(staged, source.atime, source.mtime);
    fs.renameSync(staged, target);
  } finally {
    fs.rmSync(staged, { force: true });
  }
  return target;
};

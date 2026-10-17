import fs from 'node:fs';
import path from 'node:path';

const BUNDLED_RIPGREP_DIR = 'ripgrep';

export const bundledRipgrep = (resourcesDir) => {
  if (!resourcesDir) return null;
  const file = path.join(resourcesDir, BUNDLED_RIPGREP_DIR, 'rg');
  return fs.existsSync(file) ? file : null;
};

export const engineRipgrepPath = (bases) => path.join(bases.cache, 'opencode', 'bin', 'rg');

const sameFile = (left, right) => {
  try {
    return fs.statSync(left).size === fs.statSync(right).size && fs.readFileSync(left).equals(fs.readFileSync(right));
  } catch {
    return false;
  }
};

export const placeEngineRipgrep = ({ bundled, bases }) => {
  if (!bundled) return null;
  const target = engineRipgrepPath(bases);
  if (sameFile(bundled, target)) {
    if ((fs.statSync(target).mode & 0o777) !== 0o755) fs.chmodSync(target, 0o755);
    return target;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staged = `${target}.${process.pid}.partial`;
  try {
    fs.copyFileSync(bundled, staged);
    fs.chmodSync(staged, 0o755);
    fs.renameSync(staged, target);
  } finally {
    fs.rmSync(staged, { force: true });
  }
  return target;
};

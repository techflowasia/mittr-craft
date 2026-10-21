import { randomBytes } from 'node:crypto';
import nodeFs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

export const TEMPORARY_FILE = /\.\d+-[0-9a-f]{8}\.tmp$/;

export const writePrivateAtomic = (filePath, data, { fs = nodeFs, mode = 0o600 } = {}) => {
  const temporary = `${filePath}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, data, { mode });
    if (process.platform !== 'win32') fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      throw error;
    }
    throw error;
  }
};

const readIfPresent = (file) => fsPromises.readFile(file, 'utf8').catch((error) => {
  if (error?.code === 'ENOENT') return null;
  throw error;
});

// A file that already says the same is only brought back to 0600, so its
// mtime stays put across builds. Otherwise temp + rename, so an engine
// reloading its plugins never reads half a file; each temp name is unique,
// so two builds writing at once never rename each other's file away.
export const writePrivateIfChanged = async (file, text) => {
  if (await readIfPresent(file) === text) {
    await fsPromises.chmod(file, 0o600);
    return;
  }
  writePrivateAtomic(file, text);
};

const ENGINE_PLUGIN_MANIFEST = `${JSON.stringify({ type: 'module', exports: { '.': './index.js' } }, null, 2)}\n`;

export const writeEnginePlugin = async (dir, source) => {
  await fsPromises.mkdir(dir, { recursive: true });
  await writePrivateIfChanged(path.join(dir, 'package.json'), ENGINE_PLUGIN_MANIFEST);
  await writePrivateIfChanged(path.join(dir, 'index.js'), source);
  return dir;
};

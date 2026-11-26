import fs from 'node:fs';
import path from 'node:path';

const BUNDLED_ENTRY = 'serve.mjs';
const SCRIPT_LIMIT = 64 * 1024;
const NPM_LAUNCHER = /node_modules[\\/]+(?:@opencode[\\/]+cli|opencode-ai)[\\/]+bin[\\/]+/i;
const NATIVE_MAGICS = ['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'cafebabf'];
const WINDOWS_MAGIC = '4d5a';

const realPath = (file) => {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return null;
  }
};

export const bundledEngineDirs = ({ env, resourcesDir = null }) => [
  String(env.OPENCHAMBER_BUNDLED_OPENCODE_SERVER_DIR ?? '').trim(),
  resourcesDir ? path.join(resourcesDir, 'opencode-server') : '',
].filter(Boolean);

const namedEngine = (env) => String(env.OPENCODE_BINARY ?? '').trim();

const isBundledEntry = (binary, options) => bundledEngineDirs(options).map((dir) => realPath(path.join(dir, BUNDLED_ENTRY))).includes(binary);

export const runsBundledEngine = ({ env, resourcesDir = null }) => {
  const named = namedEngine(env);
  if (!named) return bundledEngineDirs({ env, resourcesDir }).length > 0;
  const binary = realPath(named);
  return binary !== null && isBundledEntry(binary, { env, resourcesDir });
};

const readHead = (file) => {
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(SCRIPT_LIMIT);
    return buffer.subarray(0, fs.readSync(handle, buffer, 0, SCRIPT_LIMIT, 0));
  } finally {
    fs.closeSync(handle);
  }
};

const isNative = (head) => {
  const magic = head.subarray(0, 4).toString('hex');
  return NATIVE_MAGICS.includes(magic) || magic.startsWith(WINDOWS_MAGIC);
};

export const engineImportsV1 = ({ env, resourcesDir = null }) => {
  const named = namedEngine(env);
  const binary = named ? realPath(named) : null;
  if (!binary || isBundledEntry(binary, { env, resourcesDir })) return false;
  try {
    const head = readHead(binary);
    return isNative(head) || NPM_LAUNCHER.test(binary) || NPM_LAUNCHER.test(head.toString('utf8'));
  } catch {
    return false;
  }
};

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NOTICES_RESOURCE, noticeSection } from './drivers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const VAD_PIN_FILE = path.join(repoRoot, 'scripts', 'mittr', 'vad-assets.json');
export const VAD_WEB_DIST = 'web-dist';
export const VAD_DIR = 'vad';
export const VAD_PACKAGE = '@ricky0123/vad-web';
export const ORT_PACKAGE = 'onnxruntime-web';
const ORT_CHUNK_MARKER = 'ort-wasm-simd-threaded';
const NOTICES_SOURCE = path.join(repoRoot, 'brand', NOTICES_RESOURCE);

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export const readVadPins = (file = VAD_PIN_FILE) => JSON.parse(fs.readFileSync(file, 'utf8'));

export const pinnedVersion = (pins, packageName) => {
  const versions = [...new Set(pins.files.filter((file) => file.package === packageName).map((file) => file.version))];
  if (versions.length !== 1) throw new Error(`scripts/mittr/vad-assets.json pins ${versions.length} versions of ${packageName}`);
  return versions[0];
};

const packageVersion = (dir) => JSON.parse(fs.readFileSync(path.join(path.dirname(dir), 'package.json'), 'utf8')).version;

export const resolveVadSources = ({ repoRoot: root = repoRoot, pins = readVadPins() } = {}) => {
  const fromUi = createRequire(path.join(root, 'packages', 'mittr-ui', 'package.json'));
  const vadEntry = fromUi.resolve(VAD_PACKAGE);
  const ortEntry = createRequire(vadEntry).resolve(ORT_PACKAGE);
  const vadDir = path.dirname(vadEntry);
  const ortDir = path.dirname(ortEntry);
  const vadVersion = packageVersion(vadDir);
  if (vadVersion !== pinnedVersion(pins, VAD_PACKAGE)) {
    throw new Error(`${VAD_PACKAGE} resolved from packages/mittr-ui is ${vadVersion}, not the pinned ${pinnedVersion(pins, VAD_PACKAGE)}`);
  }
  const ortVersion = packageVersion(ortDir);
  if (ortVersion !== pinnedVersion(pins, ORT_PACKAGE)) {
    throw new Error(`${ORT_PACKAGE} resolved from ${VAD_PACKAGE} is ${ortVersion}, not the pinned ${pinnedVersion(pins, ORT_PACKAGE)}`);
  }
  return { vadDir, ortDir };
};

const pinMessage = (file) => `${file.name} is missing or does not match scripts/mittr/vad-assets.json (expected sha256 ${file.sha256}).`;

const sourceDir = (file, sources) => {
  if (file.package === VAD_PACKAGE) return sources.vadDir;
  if (file.package === ORT_PACKAGE) return sources.ortDir;
  throw new Error(`scripts/mittr/vad-assets.json names ${file.name} from an unknown package ${file.package}`);
};

const readPinned = (target, file) => {
  if (!fs.existsSync(target)) throw new Error(pinMessage(file));
  const bytes = fs.readFileSync(target);
  if (sha256(bytes) !== file.sha256 || bytes.length !== file.bytes) throw new Error(pinMessage(file));
  return bytes;
};

export const stageVadAssets = ({ pins, sources, outDir }) => {
  const read = pins.files.map((file) => ({ file, bytes: readPinned(path.join(sourceDir(file, sources), file.name), file) }));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  return read.map(({ file, bytes }) => {
    const target = path.join(outDir, file.name);
    fs.writeFileSync(target, bytes);
    return target;
  });
};

export const verifyPackedVadAssets = ({ appPath, pins }) => {
  const dir = path.join(appPath, 'Contents', 'Resources', VAD_WEB_DIST, VAD_DIR);
  return pins.files.map((file) => {
    const target = path.join(dir, file.name);
    if (!fs.existsSync(target)) throw new Error(`the packed app has no ${VAD_DIR}/${file.name}: ${target}`);
    const found = sha256(fs.readFileSync(target));
    if (found !== file.sha256) throw new Error(`the packed ${VAD_DIR}/${file.name} has sha256 ${found}, not the pinned ${file.sha256}`);
    return target;
  });
};

export const checkBundledOrtVersion = ({ webDist, pins, required = false }) => {
  const version = pinnedVersion(pins, ORT_PACKAGE);
  const assets = path.join(webDist, 'assets');
  const names = fs.existsSync(assets) ? fs.readdirSync(assets).filter((name) => /\.m?js$/.test(name)) : [];
  const chunks = names.filter((name) => fs.readFileSync(path.join(assets, name), 'utf8').includes(ORT_CHUNK_MARKER));
  for (const name of chunks) {
    if (!fs.readFileSync(path.join(assets, name), 'utf8').includes(`"${version}"`)) {
      throw new Error(`the bundled chunk assets/${name} carries ONNX Runtime Web but not the pinned version ${version}`);
    }
  }
  if (required && chunks.length === 0) throw new Error('no bundled chunk under web-dist/assets carries ONNX Runtime Web');
  return chunks;
};

export const checkVadNotices = ({ pins, file = NOTICES_SOURCE }) => {
  const text = fs.readFileSync(file, 'utf8');
  for (const notice of pins.notices) {
    const found = sha256(noticeSection(text, notice.heading));
    if (found !== notice.sha256) {
      throw new Error(`the ${notice.heading} section of brand/${NOTICES_RESOURCE} has sha256 ${found}, not the pinned ${notice.sha256}`);
    }
  }
  return file;
};

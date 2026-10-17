import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const RIPGREP_PIN_FILE = path.join(repoRoot, 'scripts', 'mittr', 'ripgrep.json');
export const RIPGREP_ARCHIVE_ENV = 'MITTRCRAFT_RIPGREP_ARCHIVE';
export const RIPGREP_RESOURCE_DIR = 'ripgrep';
export const RIPGREP_LICENCE_FILES = ['COPYING', 'LICENSE-MIT', 'UNLICENSE'];

const BLOCK = 512;
const FILE_TYPES = new Set(['0', '\0']);
const DIRECTORY_TYPE = '5';
const MACHO_64_MAGIC = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;

export const readRipgrepPin = (file = RIPGREP_PIN_FILE) => JSON.parse(fs.readFileSync(file, 'utf8'));

export const defaultRipgrepArchive = (pin, env = process.env) => {
  const override = String(env[RIPGREP_ARCHIVE_ENV] ?? '').trim();
  return override ? path.resolve(override) : path.join(repoRoot, 'packages', 'electron', '.cache', 'ripgrep', pin.asset);
};

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const field = (header, start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');

const unsafeEntryName = (name) => name.startsWith('/') || name.includes('\\') || name.split('/').includes('..');

export const readTarEntries = (gzipped) => {
  const archive = zlib.gunzipSync(gzipped);
  const entries = new Map();
  let offset = 0;
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const prefix = field(header, 345, 500);
    const name = prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100);
    const type = String.fromCharCode(header[156]);
    const size = Number.parseInt(field(header, 124, 136).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`the ripgrep archive entry ${JSON.stringify(name)} has no valid size`);
    if (unsafeEntryName(name)) throw new Error(`the ripgrep archive has an unsafe entry path: ${JSON.stringify(name)}`);
    if (!FILE_TYPES.has(type) && type !== DIRECTORY_TYPE) {
      throw new Error(`the ripgrep archive entry ${JSON.stringify(name)} is not a plain file or folder (type ${JSON.stringify(type)})`);
    }
    const start = offset + BLOCK;
    if (start + size > archive.length) throw new Error(`the ripgrep archive entry ${JSON.stringify(name)} is cut short`);
    if (FILE_TYPES.has(type)) entries.set(name, archive.subarray(start, start + size));
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
};

export const isMachOArm64 = (bytes) => bytes.length >= 8 && bytes.readUInt32LE(0) === MACHO_64_MAGIC && bytes.readUInt32LE(4) === CPU_TYPE_ARM64;

const missingArchiveMessage = (archive, pin) => [
  `the pinned ripgrep archive is not at ${archive}.`,
  `Put ${pin.asset} (ripgrep ${pin.version}, from ${pin.url}) there, or name its path in ${RIPGREP_ARCHIVE_ENV}.`,
  `Its sha256 must be ${pin.archiveSha256}. The build never downloads it.`,
].join(' ');

export const readPinnedArchive = ({ archive, pin }) => {
  if (!fs.existsSync(archive)) throw new Error(missingArchiveMessage(archive, pin));
  const bytes = fs.readFileSync(archive);
  const found = sha256(bytes);
  if (found !== pin.archiveSha256) {
    throw new Error(`the ripgrep archive at ${archive} has sha256 ${found}, not the pinned ${pin.archiveSha256}; put the pinned ${pin.asset} there`);
  }
  return bytes;
};

const runVersion = (binary) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-build-rg-home-'));
  try {
    return spawnSync(binary, ['--version'], { cwd: home, env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 15_000 });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
};

export const stageRipgrep = ({ archive, pin, outDir, checkVersion = process.platform === 'darwin' && process.arch === 'arm64' }) => {
  const entries = readTarEntries(readPinnedArchive({ archive, pin }));
  const top = `ripgrep-${pin.version}-${pin.target}`;
  const binary = entries.get(`${top}/rg`);
  if (!binary) throw new Error(`the ripgrep archive has no ${top}/rg`);
  if (!isMachOArm64(binary)) throw new Error(`${top}/rg in the ripgrep archive is not a Mach-O arm64 executable`);
  if (sha256(binary) !== pin.binarySha256) throw new Error(`${top}/rg has sha256 ${sha256(binary)}, not the pinned ${pin.binarySha256}`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-build-rg-'));
  try {
    const stagedBinary = path.join(work, 'rg');
    fs.writeFileSync(stagedBinary, binary, { mode: 0o755 });
    fs.chmodSync(stagedBinary, 0o755);
    for (const licence of RIPGREP_LICENCE_FILES) {
      const text = entries.get(`${top}/${licence}`);
      if (!text) throw new Error(`the ripgrep archive has no ${top}/${licence}`);
      fs.writeFileSync(path.join(work, licence), text, { mode: 0o644 });
    }
    if (checkVersion) {
      const result = runVersion(stagedBinary);
      const firstLine = String(result.stdout ?? '').split('\n')[0];
      if (result.status !== 0 || !firstLine.startsWith(`ripgrep ${pin.version}`)) {
        throw new Error(`the staged rg does not report ripgrep ${pin.version} (exit ${result.status ?? result.signal}): ${firstLine}`);
      }
    }
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    fs.cpSync(work, outDir, { recursive: true });
    fs.chmodSync(path.join(outDir, 'rg'), 0o755);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return { binary: path.join(outDir, 'rg'), sha256: pin.binarySha256 };
};

const strippedOf = (binary) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-build-rg-sig-'));
  try {
    const copy = path.join(work, 'rg');
    fs.copyFileSync(binary, copy);
    const result = spawnSync('codesign', ['--remove-signature', copy], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`codesign could not read the packed rg: ${String(result.stderr).trim()}`);
    const bytes = fs.readFileSync(copy);
    return { sha256: sha256(bytes), bytes: bytes.length };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
};

const strictSignature = (binary) => {
  const result = spawnSync('codesign', ['--verify', '--strict', binary], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`the packed rg fails codesign --verify --strict: ${String(result.stderr).trim()}`);
};

export const verifyPackedRipgrep = ({ appPath, pin, unsigned = strippedOf, verifySignature = strictSignature }) => {
  const binary = path.join(appPath, 'Contents', 'Resources', RIPGREP_RESOURCE_DIR, 'rg');
  if (!fs.existsSync(binary)) throw new Error(`the packed app has no bundled rg: ${binary}`);
  if ((fs.statSync(binary).mode & 0o111) === 0) throw new Error(`the packed rg is not executable: ${binary}`);
  for (const licence of RIPGREP_LICENCE_FILES) {
    if (!fs.existsSync(path.join(path.dirname(binary), licence))) throw new Error(`the packed app has no ripgrep ${licence} beside rg`);
  }
  verifySignature(binary);
  const bytes = fs.readFileSync(binary);
  const found = sha256(bytes);
  if (found === pin.binarySha256) {
    if (bytes.length !== pin.binaryBytes) throw new Error(`the packed rg is ${bytes.length} bytes, not the pinned ${pin.binaryBytes}`);
    return binary;
  }
  const stripped = unsigned(binary);
  if (stripped.sha256 !== pin.resignedStrippedSha256) {
    throw new Error(`the packed rg has sha256 ${found} (${stripped.sha256} without its signature), not the pinned ripgrep ${pin.version}`);
  }
  if (stripped.bytes !== pin.resignedStrippedBytes) {
    throw new Error(`the packed rg is ${stripped.bytes} bytes without its signature, not the pinned ${pin.resignedStrippedBytes}`);
  }
  return binary;
};

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

import { isRecord } from '../values.js';
import { MittrToolError } from './registry.js';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const CAPTURE_TOOL = 'openchamber_web';
export const CAPTURE_ACTION = 'browser.capture';
export const CAPTURE_IMAGE = 'capture-image';
export const TOO_LARGE = 'The image is too large to attach; it is saved at ';
export const CAPTURE_TIMEOUT_MS = 15_000;

const NOT_A_SCREENSHOT = 'That image is not a saved screenshot of this project';
export const NO_SCREENSHOT_DIRECTORY = 'A project directory is required to save a screenshot';

const MIME_BY_EXTENSION = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

const MIME_OF_BYTES = [
  ['image/png', (bytes) => bytes.subarray(0, 8).equals(PNG_SIGNATURE)],
  ['image/jpeg', (bytes) => bytes.subarray(0, 3).equals(JPEG_SIGNATURE)],
  ['image/webp', (bytes) => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP'],
];

const looksLike = (mime, bytes) => MIME_OF_BYTES.some(([candidate, matches]) => candidate === mime && matches(bytes));

const IMAGE_MIMES = new Set(MIME_BY_EXTENSION.values());
const SIGNATURE_BASE64_LENGTH = 16;

export const fitsAttachment = (base64) => Buffer.byteLength(base64, 'base64') <= MAX_IMAGE_BYTES;

export const imageOf = ({ base64, mime }) => {
  if (base64 !== String(base64) || !base64 || !IMAGE_MIMES.has(mime)) return null;
  return looksLike(mime, Buffer.from(base64.slice(0, SIGNATURE_BASE64_LENGTH), 'base64')) ? { base64, mime } : null;
};

export const imageContent = ({ base64, mime, name }) => ({ type: 'file', uri: `data:${mime};base64,${base64}`, mime, name });

const notAScreenshot = () => new MittrToolError(NOT_A_SCREENSHOT, 400);

const posix = (value) => value.split(path.sep).join('/');

const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const realOrNull = async (target, files = fsPromises) => {
  try {
    return await files.realpath(target);
  } catch {
    return null;
  }
};

const readBounded = async (handle) => {
  const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
};

const openInside = async ({ files, realFile }) => {
  try {
    return await files.open(realFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    throw notAScreenshot();
  }
};

const stillTheSameFile = async ({ files, realFile, opened }) => {
  const [now, resolved] = await Promise.all([files.lstat(realFile).catch(() => null), realOrNull(realFile, files)]);
  return now !== null && resolved === realFile && now.dev === opened.dev && now.ino === opened.ino;
};

export const sameDirectory = async (asked, directory) => {
  if (!path.isAbsolute(asked)) return false;
  const [left, right] = await Promise.all([realOrNull(asked), realOrNull(directory)]);
  return left !== null && left === right;
};

export const readCapture = async ({ directory, relativePath, folder, files = fsPromises }) => {
  if (relativePath !== String(relativePath) || directory !== String(directory) || !directory) throw notAScreenshot();
  const asked = relativePath.replaceAll('\\', '/');
  const prefix = `${posix(folder)}/`;
  if (asked.split('/').includes('..') || path.posix.isAbsolute(asked) || !asked.startsWith(prefix)) throw notAScreenshot();
  const normalized = path.posix.normalize(asked);
  if (!normalized.startsWith(prefix)) throw notAScreenshot();
  const mime = MIME_BY_EXTENSION.get(path.posix.extname(normalized).toLowerCase());
  if (!mime) throw notAScreenshot();

  const [realDirectory, realFile] = await Promise.all([realOrNull(directory, files), realOrNull(path.join(directory, normalized), files)]);
  if (!realDirectory || !realFile || !inside(path.join(realDirectory, folder), realFile)) throw notAScreenshot();
  const handle = await openInside({ files, realFile });
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !(await stillTheSameFile({ files, realFile, opened }))) throw notAScreenshot();
    const bytes = await readBounded(handle);
    if (!looksLike(mime, bytes)) throw notAScreenshot();
    if (bytes.length > MAX_IMAGE_BYTES) return { tooLarge: true };
    return { base64: bytes.toString('base64'), mime };
  } finally {
    await handle.close();
  }
};

export const attachableImage = (data) => {
  if (!isRecord(data) || !isRecord(data.image) || data.image.base64 !== String(data.image.base64)) return data;
  if (fitsAttachment(data.image.base64)) return data;
  return { ...data, image: { tooLarge: true } };
};

export const saveScreenshot = async ({ control, directory, base64, mime, label }) => {
  if (directory !== String(directory) || !directory.trim()) throw new MittrToolError(NO_SCREENSHOT_DIRECTORY, 400);
  const saved = await control.writeScreenshot({ directory, base64, mime, label });
  return { path: saved.path, image: { base64, mime } };
};

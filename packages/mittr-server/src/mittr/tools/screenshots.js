import fsPromises from 'node:fs/promises';
import path from 'node:path';

import { isRecord } from '../values.js';
import { MittrToolError } from './registry.js';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const CAPTURE_TOOL = 'openchamber_web';
export const CAPTURE_ACTION = 'browser.capture';
export const CAPTURE_IMAGE = 'capture-image';
export const TOO_LARGE = 'The image is too large to attach; it is saved at ';

const NOT_A_SCREENSHOT = 'That image is not a saved screenshot of this project';

const MIME_BY_EXTENSION = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);

export const imageContent = ({ base64, mime, name }) => ({ type: 'file', uri: `data:${mime};base64,${base64}`, mime, name });

const notAScreenshot = () => new MittrToolError(NOT_A_SCREENSHOT, 400);

const posix = (value) => value.split(path.sep).join('/');

const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const realOrNull = async (target) => {
  try {
    return await fsPromises.realpath(target);
  } catch {
    return null;
  }
};

export const sameDirectory = async (asked, directory) => {
  if (!path.isAbsolute(asked)) return false;
  const [left, right] = await Promise.all([realOrNull(asked), realOrNull(directory)]);
  return left !== null && left === right;
};

export const readCapture = async ({ directory, relativePath, folder }) => {
  if (relativePath !== String(relativePath) || directory !== String(directory) || !directory) throw notAScreenshot();
  const asked = relativePath.replaceAll('\\', '/');
  const prefix = `${posix(folder)}/`;
  if (asked.split('/').includes('..') || path.posix.isAbsolute(asked) || !asked.startsWith(prefix)) throw notAScreenshot();
  const normalized = path.posix.normalize(asked);
  if (!normalized.startsWith(prefix)) throw notAScreenshot();
  const mime = MIME_BY_EXTENSION.get(path.posix.extname(normalized).toLowerCase());
  if (!mime) throw notAScreenshot();

  const [realDirectory, realFile] = await Promise.all([realOrNull(directory), realOrNull(path.join(directory, normalized))]);
  if (!realDirectory || !realFile || !inside(path.join(realDirectory, folder), realFile)) throw notAScreenshot();
  const stat = await fsPromises.stat(realFile);
  if (!stat.isFile()) throw notAScreenshot();
  if (stat.size > MAX_IMAGE_BYTES) return { tooLarge: true };
  return { base64: (await fsPromises.readFile(realFile)).toString('base64'), mime };
};

export const attachableImage = (data) => {
  if (!isRecord(data) || !isRecord(data.image) || data.image.base64 !== String(data.image.base64)) return data;
  if (Buffer.byteLength(data.image.base64, 'base64') <= MAX_IMAGE_BYTES) return data;
  return { ...data, image: { tooLarge: true } };
};

export const saveScreenshot = async ({ control, directory, base64, mime, label }) => {
  if (directory !== String(directory) || !directory.trim()) throw new MittrToolError('A project directory is required to save a screenshot', 400);
  const saved = await control.writeScreenshot({ directory, base64, mime, label });
  return { path: saved.path, image: { base64, mime } };
};

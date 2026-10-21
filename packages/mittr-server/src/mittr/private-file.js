import { randomBytes } from 'node:crypto';
import nodeFs from 'node:fs';

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

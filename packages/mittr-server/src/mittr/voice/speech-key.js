import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { writePrivateAtomic } from '../private-file.js';
import { isPlainObject } from '../values.js';

export const SPEECH_KEY_PREFIX = 'mc_speech_';
export const VOICE_KEYS_FILE = 'voice-keys.json';
export const SPEECH_KEY_KINDS = Object.freeze(['stt', 'openaiCompatible']);

export const mintSpeechKey = () => `${SPEECH_KEY_PREFIX}${crypto.randomBytes(32).toString('hex')}`;

const digest = (value) => crypto.createHash('sha256').update(value, 'utf8').digest();

const isOurs = (value) => value === String(value) && value.startsWith(SPEECH_KEY_PREFIX);

export function createSpeechKeys({ dataDir, mint = mintSpeechKey }) {
  const key = mint();
  const expected = digest(key);
  const filePath = path.join(dataDir, VOICE_KEYS_FILE);

  const readStored = () => {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!isPlainObject(parsed)) throw new Error(`${VOICE_KEYS_FILE} is not a JSON object; it is left as it is`);
    return parsed;
  };

  const rewrite = (change) => {
    const stored = readStored();
    const next = change({ ...(stored ?? {}) });
    if (!next) return;
    fs.mkdirSync(dataDir, { recursive: true });
    writePrivateAtomic(filePath, JSON.stringify(next, null, 2));
  };

  const readQuietly = () => {
    try {
      return readStored() ?? {};
    } catch {
      return {};
    }
  };

  return {
    current: () => key,
    matches: (bearer) => {
      const presented = bearer === String(bearer) ? bearer : '';
      return presented.length > 0 && crypto.timingSafeEqual(digest(presented), expected);
    },
    installed: () => {
      const stored = readQuietly();
      return Object.fromEntries(SPEECH_KEY_KINDS.map((kind) => [kind, stored[kind] === key]));
    },
    install: (kinds) => rewrite((stored) => {
      for (const kind of kinds) {
        if (SPEECH_KEY_KINDS.includes(kind)) stored[kind] = key;
      }
      return stored;
    }),
    remove: (kind) => rewrite((stored) => {
      if (!isOurs(stored[kind])) return null;
      delete stored[kind];
      return stored;
    }),
    refreshInstalled: () => rewrite((stored) => {
      const stale = Object.keys(stored).filter((kind) => isOurs(stored[kind]) && stored[kind] !== key);
      if (stale.length === 0) return null;
      for (const kind of stale) stored[kind] = key;
      return stored;
    }),
  };
}

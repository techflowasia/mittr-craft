import nodeFs from 'node:fs';
import path from 'node:path';

import { writePrivateAtomic } from './private-file.js';
import { isPlainObject, isRecord } from './values.js';

const own = (record, key) => (isRecord(record) && Object.hasOwn(record, key) ? record[key] : undefined);

export function createEnablementStore({ filePath, fs = nodeFs }) {
  const load = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };

  return {
    isEnabled: (kind, name) => own(own(load(), kind), name)?.disabled !== true,
    setEnabled: (kind, name, enabled) => {
      const state = load();
      const entries = { ...(isRecord(own(state, kind)) ? state[kind] : {}) };
      if (enabled) {
        delete entries[name];
      } else {
        Object.defineProperty(entries, name, {
          value: { disabled: true, at: new Date().toISOString() },
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      state[kind] = entries;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      writePrivateAtomic(filePath, JSON.stringify(state, null, 2), { fs });
    },
    all: () => load(),
  };
}

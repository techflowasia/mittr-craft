import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';

import {
  engineConfigDir,
  engineDataDir,
  engineHomeEnv,
  legacyEngineConfigDir,
  legacyEngineDataDir,
  migrateEngineHome,
} from './home.js';

const withEnv = (value, body) => {
  const previous = process.env.MITTRCRAFT_ENGINE_HOME;
  if (value === undefined) delete process.env.MITTRCRAFT_ENGINE_HOME;
  else process.env.MITTRCRAFT_ENGINE_HOME = value;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.MITTRCRAFT_ENGINE_HOME;
    else process.env.MITTRCRAFT_ENGINE_HOME = previous;
  }
};

describe('engine home', () => {
  it('does not share a directory with a separately installed engine', () => {
    withEnv(undefined, () => {
      expect(engineConfigDir()).not.toBe(legacyEngineConfigDir());
      expect(engineDataDir()).not.toBe(legacyEngineDataDir());
    });
  });

  it('is not nested inside the shared home either', () => {
    withEnv(undefined, () => {
      expect(engineConfigDir().startsWith(legacyEngineConfigDir())).toBe(false);
      expect(engineDataDir().startsWith(legacyEngineDataDir())).toBe(false);
    });
  });

  it('ends in the directory name the engine appends itself', () => {
    withEnv(undefined, () => {
      expect(path.basename(engineConfigDir())).toBe('opencode');
      expect(path.basename(engineDataDir())).toBe('opencode');
    });
  });

  it('sets every XDG base, so no half of the installation stays behind', () => {
    withEnv(undefined, () => {
      const env = engineHomeEnv();
      expect(Object.keys(env).sort()).toEqual([
        'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
      ]);
      for (const value of Object.values(env)) {
        expect(value.startsWith(os.homedir())).toBe(true);
        expect(value).not.toBe(path.join(os.homedir(), '.config'));
        expect(value).not.toBe(path.join(os.homedir(), '.local', 'share'));
      }
    });
  });

  it('an override moves the whole home together', () => {
    withEnv('/tmp/engine-home-test', () => {
      const env = engineHomeEnv();
      for (const value of Object.values(env)) {
        expect(value).toBe(path.resolve('/tmp/engine-home-test'));
      }
      expect(engineConfigDir()).toBe(path.join(path.resolve('/tmp/engine-home-test'), 'opencode'));
    });
  });
});

describe('migrateEngineHome', () => {
  const fakeFs = (files) => {
    const copied = [];
    return {
      copied,
      readdirSync: (dir) => {
        const entries = files[dir];
        if (!entries) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return entries;
      },
      existsSync: (target) => (files.existing ?? []).includes(path.basename(target)),
      mkdirSync: () => {},
      copyFileSync: (from, to) => copied.push([path.basename(from), path.dirname(to)]),
    };
  };
  const quiet = { log: () => {}, warn: () => {} };

  it('carries the session database across', () => {
    const fsImpl = fakeFs({ [legacyEngineDataDir()]: ['opencode-.db', 'opencode-.db-shm', 'auth.json'] });
    const result = migrateEngineHome({ fsImpl, log: quiet });
    expect(result.migrated).toBe(true);
    expect(result.copied).toEqual(['opencode-.db', 'opencode-.db-shm']);
  });

  it('never carries credentials', () => {
    const fsImpl = fakeFs({ [legacyEngineDataDir()]: ['opencode-.db', 'auth.json'] });
    migrateEngineHome({ fsImpl, log: quiet });
    expect(fsImpl.copied.map(([name]) => name)).not.toContain('auth.json');
  });

  it('does nothing when there is no previous installation', () => {
    const result = migrateEngineHome({ fsImpl: fakeFs({}), log: quiet });
    expect(result).toEqual({ migrated: false, reason: 'no-previous-installation' });
  });

  it('does not overwrite a database already in the new home', () => {
    const fsImpl = fakeFs({ [legacyEngineDataDir()]: ['opencode-.db'], existing: ['opencode-.db'] });
    const result = migrateEngineHome({ fsImpl, log: quiet });
    expect(result).toEqual({ migrated: false, reason: 'already-present' });
    expect(fsImpl.copied).toEqual([]);
  });

  it('reports rather than throws when the copy fails', () => {
    const fsImpl = fakeFs({ [legacyEngineDataDir()]: ['opencode-.db'] });
    fsImpl.copyFileSync = () => { throw new Error('EACCES'); };
    expect(migrateEngineHome({ fsImpl, log: quiet })).toEqual({ migrated: false, reason: 'copy-failed' });
  });
});

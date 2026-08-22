import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import path from 'node:path';
import { loadDesktopServerEnv, resolveDesktopServerEnvFile } from './desktop-server-env.mjs';

const fileStat = (mode = 0o100600) => ({
  isFile: () => true,
  mode,
});

describe('desktop server environment', () => {
  it('resolves the default file outside the packaged application', () => {
    assert.equal(resolveDesktopServerEnvFile({
      environment: {},
      homeDirectory: '/Users/example',
    }), path.join('/Users/example', '.config', 'openchamber', 'desktop.env'));
  });

  it('uses an explicit environment file path', () => {
    assert.equal(resolveDesktopServerEnvFile({
      environment: { OPENCHAMBER_DESKTOP_ENV_FILE: './private/desktop.env' },
      homeDirectory: '/Users/example',
    }), path.resolve('./private/desktop.env'));
  });

  it('leaves startup unchanged when the default file is absent', () => {
    const result = loadDesktopServerEnv({
      environment: {},
      homeDirectory: '/Users/example',
      statSync: () => {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      },
    });

    assert.deepEqual(result, {
      status: 'missing',
      filePath: path.join('/Users/example', '.config', 'openchamber', 'desktop.env'),
    });
  });

  it('loads a private environment file before the local server starts', () => {
    const loaded = [];
    const result = loadDesktopServerEnv({
      environment: {},
      homeDirectory: '/Users/example',
      platform: 'darwin',
      statSync: () => fileStat(),
      loadEnvFile: (filePath) => loaded.push(filePath),
    });

    assert.deepEqual(loaded, [path.join('/Users/example', '.config', 'openchamber', 'desktop.env')]);
    assert.equal(result.status, 'loaded');
  });

  it('rejects a group-readable environment file on POSIX systems', () => {
    assert.throws(() => loadDesktopServerEnv({
      environment: {},
      homeDirectory: '/Users/example',
      platform: 'darwin',
      statSync: () => fileStat(0o100640),
      loadEnvFile: () => {},
    }), /must use permissions 0600/);
  });
});

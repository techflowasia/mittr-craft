import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMittrShim } from './index.js';

let dir;
const env = { MITTRCRAFT_UPSTREAM_URL: 'https://upstream.test/v1' };
const brokerBaseUrl = 'https://mittr.test';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-shim-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('startMittrShim', () => {
  it('returns the local token and the loopback base url', () => {
    const result = startMittrShim({
      app: express(),
      host: '127.0.0.1',
      port: 3902,
      dataDir: dir,
      brokerBaseUrl,
      env,
    });
    expect(result.localToken).toMatch(/^mc_local_/);
    expect(result.baseUrl).toBe('http://127.0.0.1:3902/v1');
  });

  it('refuses to start when the host is not loopback', () => {
    expect(() => startMittrShim({
      app: express(),
      host: '0.0.0.0',
      port: 3902,
      dataDir: dir,
      brokerBaseUrl,
      env,
    })).toThrow(/loopback/);
  });

  it('applies an empty model list when nothing is cached, so a model left by an older build is dropped', async () => {
    const syncModels = vi.fn();
    const shim = startMittrShim({
      app: express(), host: '127.0.0.1', port: 3902, dataDir: dir, brokerBaseUrl, env, syncModels,
    });
    await shim.applyCachedCatalog();
    expect(syncModels).toHaveBeenCalledWith([]);
  });

  it('applies the cached models before any network call', async () => {
    const syncModels = vi.fn();
    fs.writeFileSync(path.join(dir, 'mittr-catalog.json'), JSON.stringify({
      bundleVersion: 7,
      models: { configured: true, items: [{ alias: 'pm_9f2c1d4e7b', label: 'MittrCraft 1.0' }] },
    }));
    const shim = startMittrShim({
      app: express(), host: '127.0.0.1', port: 3902, dataDir: dir, brokerBaseUrl, env, syncModels,
    });
    await shim.applyCachedCatalog();
    expect(syncModels).toHaveBeenCalledWith([{ alias: 'pm_9f2c1d4e7b', label: 'MittrCraft 1.0' }]);
  });

  it('refuses to start when the upstream is unconfigured', () => {
    expect(() => startMittrShim({
      app: express(),
      host: '127.0.0.1',
      port: 3902,
      dataDir: dir,
      brokerBaseUrl,
      env: {},
    })).toThrow(/MITTRCRAFT_UPSTREAM_URL/);
  });
});

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

  it('starts with nothing configured, because a packaged build sets no environment', () => {
    // This is the packaged case, and it used to throw: the shim required
    // MITTRCRAFT_UPSTREAM_URL, nothing in the desktop set it, and the whole
    // Mittr provider was silently absent from every build.
    expect(() => startMittrShim({
      app: express(),
      host: '127.0.0.1',
      port: 3902,
      dataDir: dir,
      brokerBaseUrl,
      env: {},
    })).not.toThrow();
  });

  it('still refuses to start when there is no broker to derive an upstream from', () => {
    expect(() => startMittrShim({
      app: express(),
      host: '127.0.0.1',
      port: 3902,
      dataDir: dir,
      brokerBaseUrl: '',
      env: {},
    })).toThrow(/MITTRCRAFT_UPSTREAM_URL|valid URL/);
  });
});

describe('startMittrShim with several Mittr accounts', () => {
  const sessionFor = (userId, displayName) => ({
    accessToken: `at-${userId}`,
    refreshToken: `rt-${userId}`,
    expiresAt: Date.now() + 3_600_000,
    subject: { userId, displayName },
  });

  it('switching account moves the engine to that account, applies its own catalog and restarts the engine', async () => {
    const { createAccountStore } = await import('./account-store.js');
    const { createPlaintextSecretStore } = await import('./index.js');
    const { engineDataDir, setEngineAccount } = await import('../opencode/home.js');
    const request = (await import('supertest')).default;
    const accounts = createAccountStore({ dataDir: dir, ...createPlaintextSecretStore() });
    accounts.write(sessionFor('u1', 'Chaiwat'));
    accounts.write(sessionFor('u2', 'Chaiwat (test)'));
    const secondHome = accounts.activeHome();
    fs.writeFileSync(path.join(dir, 'mittr-catalog.json'), JSON.stringify({
      models: { configured: true, items: [{ alias: 'pm_first', label: 'First' }] },
    }));
    fs.writeFileSync(path.join(dir, 'mittr-accounts', `${secondHome}.catalog.json`), JSON.stringify({
      models: { configured: true, items: [{ alias: 'pm_second', label: 'Second' }] },
    }));

    const app = express();
    const syncModels = vi.fn();
    const refreshEngine = vi.fn();
    const onEngineAccountChange = vi.fn();
    const shim = startMittrShim({
      app, host: '127.0.0.1', port: 3902, dataDir: dir, brokerBaseUrl, env,
      syncModels, refreshEngine, onEngineAccountChange,
    });
    expect(engineDataDir()).toContain(path.join('accounts', secondHome));
    await shim.applyCachedCatalog();
    expect(syncModels).toHaveBeenLastCalledWith([{ alias: 'pm_second', label: 'Second' }]);

    await request(app).post('/api/mittr/auth/accounts/activate').send({ userId: 'u1' }).expect(200);

    expect(engineDataDir()).not.toContain('accounts');
    expect(onEngineAccountChange).toHaveBeenCalledTimes(1);
    expect(syncModels).toHaveBeenLastCalledWith([{ alias: 'pm_first', label: 'First' }]);
    expect(refreshEngine).toHaveBeenCalledWith('Mittr account switched');
    setEngineAccount(null);
  });
});

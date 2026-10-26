import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const isolated = await vi.hoisted(async () => {
  const hoistedFs = await import('node:fs');
  const hoistedOs = await import('node:os');
  const hoistedPath = await import('node:path');
  const names = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const home = hoistedFs.realpathSync(hoistedFs.mkdtempSync(hoistedPath.join(hoistedOs.tmpdir(), 'quota-home-')));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = hoistedPath.join(home, '.config');
  process.env.XDG_DATA_HOME = hoistedPath.join(home, '.local', 'share');
  process.env.XDG_STATE_HOME = hoistedPath.join(home, '.local', 'state');
  process.env.XDG_CACHE_HOME = hoistedPath.join(home, '.cache');
  return { home, saved };
});

vi.mock('../../opencode/auth.js', () => ({ readOpenCodeCredentials: async () => ({}) }));

import { fetchQuotaForProvider, listConfiguredQuotaProviders, registerQuotaProvider } from './index.js';

afterAll(() => {
  for (const [name, value] of Object.entries(isolated.saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(isolated.home, { recursive: true, force: true });
});

it('every provider runs under a temporary home, never the real one', () => {
  expect(os.homedir()).toBe(isolated.home);
  expect(process.env.XDG_CONFIG_HOME?.startsWith(isolated.home)).toBe(true);
});

const originalPath = process.env.PATH;
let keychainLog;
let shimDir;

beforeEach(() => {
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-keychain-'));
  keychainLog = path.join(shimDir, 'calls.log');
  const shim = path.join(shimDir, 'security');
  fs.writeFileSync(shim, `#!/bin/sh\necho "$@" >> "${keychainLog}"\nexit 44\n`, { mode: 0o755 });
  process.env.PATH = `${shimDir}${path.delimiter}${originalPath}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  fs.rmSync(shimDir, { recursive: true, force: true });
});

const keychainCalls = () => (fs.existsSync(keychainLog) ? fs.readFileSync(keychainLog, 'utf8').trim().split('\n') : []);

const entry = (providerId, extra = {}) => ({
  providerId,
  providerName: providerId.toUpperCase(),
  isConfigured: () => true,
  fetchQuota: async () => ({ providerId, ok: true }),
  ...extra,
});

describe('registerQuotaProvider', () => {
  it('a registered provider is listed and fetched', async () => {
    const unregister = registerQuotaProvider(entry('x-listed'));
    try {
      await expect(listConfiguredQuotaProviders()).resolves.toContain('x-listed');
      await expect(fetchQuotaForProvider('x-listed')).resolves.toMatchObject({ providerId: 'x-listed', ok: true });
    } finally {
      unregister();
    }
  });

  it('duplicate id throws', () => {
    const unregister = registerQuotaProvider(entry('x-duplicate'));
    try {
      expect(() => registerQuotaProvider(entry('x-duplicate'))).toThrow(/x-duplicate/);
      expect(() => registerQuotaProvider(entry('openrouter'))).toThrow(/openrouter/);
    } finally {
      unregister();
    }
  });

  it('unregister removes it', async () => {
    const unregister = registerQuotaProvider(entry('x-removed'));
    unregister();
    await expect(listConfiguredQuotaProviders()).resolves.not.toContain('x-removed');
    await expect(fetchQuotaForProvider('x-removed')).resolves.toMatchObject({ ok: false, configured: false, error: 'Unsupported provider' });
    expect(() => unregister()).not.toThrow();
  });

  it('an old unregister does not remove a later registration of the same id', async () => {
    const first = registerQuotaProvider(entry('x-again'));
    first();
    const second = registerQuotaProvider(entry('x-again'));
    try {
      first();
      await expect(listConfiguredQuotaProviders()).resolves.toContain('x-again');
    } finally {
      second();
    }
  });

  it('a provider that is not configured is not listed', async () => {
    const unregister = registerQuotaProvider(entry('x-off', { isConfigured: () => false }));
    try {
      await expect(listConfiguredQuotaProviders()).resolves.not.toContain('x-off');
    } finally {
      unregister();
    }
  });

  it('rejects an entry that cannot be dispatched', () => {
    expect(() => registerQuotaProvider({ providerId: 'x-bad', providerName: 'Bad' })).toThrow(TypeError);
    expect(() => registerQuotaProvider(null)).toThrow(TypeError);
  });

  it('rejects an id that is not lowercase letters, digits and dashes', () => {
    for (const providerId of ['', 'X', 'has space', '-leading', '__proto__', 'a/b', 'constructor.x']) {
      expect(() => registerQuotaProvider(entry(providerId)), providerId).toThrow(TypeError);
    }
    registerQuotaProvider(entry('x-1-ok'))();
  });

  it('a built-in id cannot be taken over or shadowed', async () => {
    expect(() => registerQuotaProvider(entry('openrouter'))).toThrow(/openrouter/);
    expect(() => registerQuotaProvider(entry('github-copilot-addon'))).toThrow(/github-copilot-addon/);
  });
});

describe('an exclusive quota provider', () => {
  const providerModules = import.meta.glob(['./*.js', './*/index.js', '!./*.test.js', '!./index.js', '!./registered.js'], { eager: true });
  const BUILT_IN_IDS = [...new Set(Object.values(providerModules).flatMap((module) => [module.providerId, module.providerIdAddon]).filter(Boolean))];
  it('while it is registered no built-in provider is listed, fetched, or reads the keychain', async () => {
    expect(BUILT_IN_IDS.length).toBeGreaterThan(20);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'));
    const unregister = registerQuotaProvider(entry('x-alone'), { exclusive: true });
    try {
      await expect(listConfiguredQuotaProviders()).resolves.toEqual(['x-alone']);
      for (const providerId of BUILT_IN_IDS) {
        await expect(fetchQuotaForProvider(providerId)).resolves.toMatchObject({ ok: false, configured: false, error: 'Unsupported provider' });
      }
      await expect(fetchQuotaForProvider('x-alone')).resolves.toMatchObject({ providerId: 'x-alone', ok: true });
      expect(keychainCalls()).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      unregister();
      fetchSpy.mockRestore();
    }
  });

  it.runIf(process.platform === 'darwin')('once it is removed the built-in providers read the keychain again', async () => {
    const unregister = registerQuotaProvider(entry('x-alone-again'), { exclusive: true });
    unregister();
    await listConfiguredQuotaProviders();
    expect(keychainCalls().some((line) => line.startsWith('find-generic-password'))).toBe(true);
  });

  it.runIf(process.platform === 'darwin')('a provider registered without it leaves the built-in providers in place', async () => {
    const unregister = registerQuotaProvider(entry('x-beside'));
    try {
      await listConfiguredQuotaProviders();
      expect(keychainCalls().some((line) => line.startsWith('find-generic-password'))).toBe(true);
    } finally {
      unregister();
    }
  });
});

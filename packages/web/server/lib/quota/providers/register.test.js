import { describe, expect, it, vi } from 'vitest';

vi.mock('../../opencode/auth.js', () => ({ readOpenCodeCredentials: async () => ({}) }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  const refuse = () => { throw new Error('no child process in this test'); };
  return { ...actual, default: actual, execFileSync: vi.fn(refuse), execFile: vi.fn(refuse), spawn: vi.fn(refuse) };
});

import * as childProcess from 'child_process';
import { fetchQuotaForProvider, listConfiguredQuotaProviders, registerQuotaProvider } from './index.js';

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
  const BUILT_IN_IDS = ['cline-pass', 'codex', 'cursor', 'deepinfra', 'deepseek', 'exe-dev', 'google', 'hyper', 'zai-coding-plan', 'zhipuai-coding-plan', 'kimi-for-coding', 'openrouter', 'nano-gpt', 'github-copilot', 'github-copilot-addon', 'minimax-coding-plan', 'minimax-cn-coding-plan', 'ollama-cloud', 'wafer', 'opencode-go', 'neuralwatt', 'kilo', 'zenmux', 'xai'];

  it('while it is registered no built-in provider is listed, fetched, or reads a credential', async () => {
    childProcess.execFileSync.mockClear();
    childProcess.execFile.mockClear();
    childProcess.spawn.mockClear();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'));
    const unregister = registerQuotaProvider(entry('x-alone'), { exclusive: true });
    try {
      await expect(listConfiguredQuotaProviders()).resolves.toEqual(['x-alone']);
      for (const providerId of BUILT_IN_IDS) {
        await expect(fetchQuotaForProvider(providerId)).resolves.toMatchObject({ ok: false, configured: false, error: 'Unsupported provider' });
      }
      await expect(fetchQuotaForProvider('x-alone')).resolves.toMatchObject({ providerId: 'x-alone', ok: true });
      expect(childProcess.execFileSync).not.toHaveBeenCalled();
      expect(childProcess.execFile).not.toHaveBeenCalled();
      expect(childProcess.spawn).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      unregister();
      fetchSpy.mockRestore();
    }
  });

  it('once it is removed the built-in providers are asked again', async () => {
    childProcess.execFileSync.mockClear();
    const unregister = registerQuotaProvider(entry('x-alone-again'), { exclusive: true });
    unregister();
    await listConfiguredQuotaProviders();
    if (process.platform === 'darwin') {
      expect(childProcess.execFileSync).toHaveBeenCalledWith('security', expect.arrayContaining(['find-generic-password']), expect.anything());
    }
  });

  it('a provider registered without it leaves the built-in providers in place', async () => {
    childProcess.execFileSync.mockClear();
    const unregister = registerQuotaProvider(entry('x-beside'));
    try {
      await listConfiguredQuotaProviders();
      if (process.platform === 'darwin') expect(childProcess.execFileSync).toHaveBeenCalled();
    } finally {
      unregister();
    }
  });
});

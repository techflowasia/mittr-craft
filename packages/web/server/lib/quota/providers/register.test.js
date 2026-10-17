import { describe, expect, it, vi } from 'vitest';

vi.mock('../../opencode/auth.js', () => ({ readOpenCodeCredentials: async () => ({}) }));

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

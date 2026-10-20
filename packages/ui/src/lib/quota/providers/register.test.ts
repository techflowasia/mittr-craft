import { beforeEach, describe, expect, test } from 'bun:test';

import { useQuotaStore } from '@/stores/useQuotaStore';
import { QUOTA_PROVIDERS, registerQuotaProvider, selectRegisteredQuotaProvider } from './index';

const select = (id: string) => selectRegisteredQuotaProvider(id, useQuotaStore.getState().setSelectedProvider);

describe('registering a quota provider at run time', () => {
  beforeEach(() => {
    useQuotaStore.setState({ selectedProviderId: null });
  });

  test('first registration goes to the front', () => {
    const before = QUOTA_PROVIDERS.length;
    registerQuotaProvider({ id: 'probe-front', name: 'Probe front' }, { first: true });
    expect(QUOTA_PROVIDERS[0]).toEqual({ id: 'probe-front', name: 'Probe front' });
    expect(QUOTA_PROVIDERS.length).toBe(before + 1);
  });

  test('a registration without first goes to the end', () => {
    registerQuotaProvider({ id: 'probe-end', name: 'Probe end' });
    expect(QUOTA_PROVIDERS[QUOTA_PROVIDERS.length - 1]?.id).toBe('probe-end');
  });

  test('registering twice is a no-op', () => {
    registerQuotaProvider({ id: 'probe-twice', name: 'Probe twice' }, { first: true });
    const snapshot = QUOTA_PROVIDERS.map((provider) => provider.id);
    registerQuotaProvider({ id: 'probe-twice', name: 'Renamed' }, { first: false });
    expect(QUOTA_PROVIDERS.map((provider) => provider.id)).toEqual(snapshot);
    expect(QUOTA_PROVIDERS.filter((provider) => provider.name === 'Probe twice')).toHaveLength(1);
    expect(QUOTA_PROVIDERS.filter((provider) => provider.name === 'Renamed')).toHaveLength(0);
  });

  test('a registered provider can be selected', () => {
    registerQuotaProvider({ id: 'probe-select', name: 'Probe select' });
    select('probe-select');
    expect(useQuotaStore.getState().selectedProviderId).toBe('probe-select');
  });

  test('an id that was never registered is not selected', () => {
    select('probe-unknown');
    expect(useQuotaStore.getState().selectedProviderId).toBeNull();
  });
});

describe('an exclusive quota provider', () => {
  test('takes every built-in provider off the list and keeps the run-time ones', () => {
    registerQuotaProvider({ id: 'probe-kept', name: 'Probe kept' });
    expect(QUOTA_PROVIDERS.some((provider) => provider.id === 'google')).toBe(true);
    registerQuotaProvider({ id: 'probe-alone', name: 'Probe alone' }, { first: true, exclusive: true });
    expect(QUOTA_PROVIDERS[0]?.id).toBe('probe-alone');
    expect(QUOTA_PROVIDERS.some((provider) => provider.id === 'probe-kept')).toBe(true);
    for (const id of ['codex', 'cursor', 'github-copilot', 'google', 'openrouter', 'xai']) {
      expect(QUOTA_PROVIDERS.some((provider) => provider.id === id)).toBe(false);
    }
    registerQuotaProvider({ id: 'probe-later', name: 'Probe later' });
    expect(QUOTA_PROVIDERS.some((provider) => provider.id === 'probe-later')).toBe(true);
  });
});

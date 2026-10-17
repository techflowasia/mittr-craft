import { beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';

import { QUOTA_PROVIDERS } from '../../../ui/src/lib/quota/providers';
import { buildSettingsSearchResults } from '../../../ui/src/lib/settings/search';
import { dict as enDict } from '../../../ui/src/lib/i18n/messages/en';
import { overlayDictionary } from '../../../ui/src/lib/product-plugins';
import { useQuotaStore } from '../../../ui/src/stores/useQuotaStore';
import { MittrRoot } from '../product-ui-plugin';
import { selectMittrUsage } from './registerMittrUsage';

const runtimeCtx = {
  isVSCode: false,
  isWeb: true,
  isDesktop: true,
  isMobile: false,
  isDesktopLocalOrigin: false,
  isMac: true,
  isWindows: false,
  isLinux: false,
  routingAvailable: false,
  enterpriseMode: false,
  jevBlockedByEnterprise: false,
};

describe('the Mittr usage provider', () => {
  beforeEach(() => {
    useQuotaStore.setState({ selectedProviderId: null });
  });

  test('Mittr is the first usage provider', () => {
    expect(QUOTA_PROVIDERS[0]).toEqual({ id: 'mittr', name: 'Mittr' });
    expect(QUOTA_PROVIDERS.filter((provider) => provider.name === 'Mittr')).toHaveLength(1);
  });

  test('Mittr becomes the selected usage provider when none is chosen', () => {
    selectMittrUsage();
    expect(useQuotaStore.getState().selectedProviderId).toBe('mittr');
  });

  test('a chosen provider is kept', () => {
    useQuotaStore.setState({ selectedProviderId: 'codex' });
    selectMittrUsage();
    expect(useQuotaStore.getState().selectedProviderId).toBe('codex');
  });

  test('the choice is made inside the sign-in gate, so only once someone is signed in', () => {
    const gate = MittrRoot({ children: 'app' });
    expect(React.isValidElement<{ children: React.ReactNode }>(gate)).toBe(true);
    if (!React.isValidElement<{ children: React.ReactNode }>(gate)) return;
    const inside = React.Children.toArray(gate.props.children);
    expect(inside).toHaveLength(2);
    expect(inside[1]).toBe('app');
    expect(React.isValidElement(inside[0]) && typeof inside[0].type === 'function').toBe(true);
  });
});

describe('settings search for the weekly quota', () => {
  const merged = overlayDictionary('en', enDict);
  const t = (key: keyof typeof enDict) => merged[key] ?? key;
  const find = (query: string) => buildSettingsSearchResults({ query, runtimeCtx, t, getPageTitle: (page) => page });

  test('settings search finds usage for quota and weekly', () => {
    for (const query of ['quota', 'weekly']) {
      expect(find(query).some((result) => result.page === 'usage')).toBe(true);
    }
  });

  test('the model quotas heading names the week', () => {
    expect(merged['settings.usage.page.section.modelQuotas']).toBe('Weekly model quotas');
    expect(find('weekly').find((result) => result.id === 'usage.model-quotas')?.title).toBe('Weekly model quotas');
  });
});

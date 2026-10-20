import { updateDesktopSettings } from '../../../ui/src/lib/persistence';
import { QUOTA_PROVIDERS, registerQuotaProvider, selectRegisteredQuotaProvider } from '../../../ui/src/lib/quota/providers';
import { useQuotaStore } from '../../../ui/src/stores/useQuotaStore';
import { keepMittrInUsageDropdown, storedAddedMark } from './usageDropdown';

const MITTR_QUOTA_PROVIDER_ID = 'mittr';

registerQuotaProvider({ id: MITTR_QUOTA_PROVIDER_ID, name: 'Mittr' }, { first: true, exclusive: true });

useQuotaStore.setState((state) => ({
  dropdownProviderIds: state.dropdownProviderIds.filter((id) => QUOTA_PROVIDERS.some((provider) => provider.id === id)),
}));

selectRegisteredQuotaProvider(MITTR_QUOTA_PROVIDER_ID, (mittr) => keepMittrInUsageDropdown(useQuotaStore, mittr, {
  persist: async (ids) => {
    await updateDesktopSettings({ usageDropdownProviders: ids });
  },
  ...storedAddedMark(() => globalThis.localStorage),
}));

export function selectMittrUsage(): void {
  const { selectedProviderId, setSelectedProvider } = useQuotaStore.getState();
  if (selectedProviderId !== null) return;
  selectRegisteredQuotaProvider(MITTR_QUOTA_PROVIDER_ID, setSelectedProvider);
}

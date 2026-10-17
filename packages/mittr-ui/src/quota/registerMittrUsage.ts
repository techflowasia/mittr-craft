import { registerQuotaProvider, selectRegisteredQuotaProvider } from '../../../ui/src/lib/quota/providers';
import { useQuotaStore } from '../../../ui/src/stores/useQuotaStore';

const MITTR_QUOTA_PROVIDER_ID = 'mittr';

registerQuotaProvider({ id: MITTR_QUOTA_PROVIDER_ID, name: 'Mittr' }, { first: true });

export function selectMittrUsage(): void {
  const { selectedProviderId, setSelectedProvider } = useQuotaStore.getState();
  if (selectedProviderId !== null) return;
  selectRegisteredQuotaProvider(MITTR_QUOTA_PROVIDER_ID, setSelectedProvider);
}

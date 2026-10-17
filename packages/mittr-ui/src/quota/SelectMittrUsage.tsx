import React from 'react';

import { useQuotaStore } from '../../../ui/src/stores/useQuotaStore';
import { selectMittrUsage } from './registerMittrUsage';

export function SelectMittrUsage(): React.ReactNode {
  const selectedProviderId = useQuotaStore((state) => state.selectedProviderId);
  React.useEffect(() => {
    if (selectedProviderId === null) selectMittrUsage();
  }, [selectedProviderId]);
  return null;
}

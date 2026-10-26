import React from 'react';

import { useSessionDisplayStore } from '../../../ui/src/stores/useSessionDisplayStore';

export const RECENT_DEFAULT_KEY = 'mittr.sidebar.recentDefault';

type DefaultStorage = { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };

export function applyRecentSectionDefault({ storage, shown, show }: { storage: DefaultStorage; shown: boolean; show: () => void }): void {
  try {
    if (storage.getItem(RECENT_DEFAULT_KEY)) return;
    storage.setItem(RECENT_DEFAULT_KEY, '1');
  } catch {
    return;
  }
  if (!shown) show();
}

export function MittrRecentSectionDefault(): null {
  React.useEffect(() => {
    const display = useSessionDisplayStore.getState();
    applyRecentSectionDefault({
      storage: window.localStorage,
      shown: display.showRecentSection,
      show: () => display.setShowRecentSection(true),
    });
  }, []);
  return null;
}

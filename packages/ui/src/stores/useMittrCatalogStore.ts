import { create } from 'zustand';
import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * Which engine provider carries the models Mittr granted.
 *
 * Read from the server rather than written here. Every model in the catalog is
 * registered under one provider id, and that id is the server's to choose; a
 * surface that hardcoded it would start hiding the granted models the day it
 * moved, which is the failure mode this store exists to avoid.
 *
 * `null` means "not known yet" and is deliberately different from a value:
 * until the answer arrives, nothing can be called external, so nothing is
 * hidden. A fetch that fails leaves it null for the same reason — an
 * unreachable catalog is not evidence that a provider was not granted.
 */
type MittrCatalogStore = {
  grantedProviderId: string | null;
  loaded: boolean;
  refresh: () => Promise<void>;
};

const CATALOG_ENDPOINT = '/api/mittr/catalog';

export const useMittrCatalogStore = create<MittrCatalogStore>()((set) => ({
  grantedProviderId: null,
  loaded: false,
  refresh: async () => {
    try {
      const response = await runtimeFetch(CATALOG_ENDPOINT);
      if (!response.ok) {
        set({ loaded: true });
        return;
      }
      const payload = await response.json() as { providerId?: unknown };
      const providerId = typeof payload?.providerId === 'string' && payload.providerId.trim()
        ? payload.providerId.trim()
        : null;
      set({ grantedProviderId: providerId, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
}));

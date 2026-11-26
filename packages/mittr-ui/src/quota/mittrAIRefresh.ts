import React from 'react';
import { runtimeFetch } from '../../../ui/src/lib/runtime-fetch';
import { subscribeRuntimeEndpointChanged } from '../../../ui/src/lib/runtime-switch';
import { registerQuotaProviderRefreshHook } from '../../../ui/src/lib/quota/providers';
import { useQuotaStore } from '../../../ui/src/stores/useQuotaStore';
import { MITTR_PROVIDER_ID } from '../mittrProvider';
import { watchSignedInAccount } from '../sign-in/signedInAccount';
import { sharedQuotaMeController } from './quotaMeStore';

type RefreshDeps = {
  fetch: (path: string, options: { method: 'POST'; headers: { 'content-type': string }; body: string; signal: AbortSignal }) => Promise<{ ok: boolean }>;
  quota: (options: { force: boolean }) => Promise<void>;
};

export function createMittrAIRefresh({ fetch, quota }: RefreshDeps) {
  const controller = new AbortController();
  let pending: Promise<void> | null = null;
  const catalog = (): Promise<void> => {
    if (controller.signal.aborted) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      try {
        await fetch('/api/mittr/catalog/sync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ force: false }), signal: controller.signal,
        });
      } catch {
        // Keep the last applied catalog. The next demand retries through the server gate.
      }
    })().finally(() => { pending = null; });
    return pending;
  };
  return {
    catalog,
    refresh: async () => {
      if (controller.signal.aborted) return;
      await Promise.allSettled([catalog(), quota({ force: true })]);
    },
    dispose: () => controller.abort(),
  };
}

let active: ReturnType<typeof createMittrAIRefresh> | null = null;

export function refreshMittrCatalog(): Promise<void> {
  return active?.catalog() ?? Promise.resolve();
}

export function MittrAIRefresh(): null {
  React.useEffect(() => {
    const quota = sharedQuotaMeController();
    // Keep owner watches alive even when no quota-bearing surface is open.
    const stopQuota = quota.subscribe(() => {});
    const make = () => createMittrAIRefresh({ fetch: runtimeFetch, quota: quota.load });
    let coordinator = make();
    active = coordinator;
    const unregister = registerQuotaProviderRefreshHook(MITTR_PROVIDER_ID, () => coordinator.refresh());
    let lastRevalidation = 0;
    const refreshVisible = () => {
      if (document.visibilityState === 'hidden') return;
      void coordinator.catalog();
      if (Date.now() - lastRevalidation < 30_000) return;
      lastRevalidation = Date.now();
      const provider = useQuotaStore.getState().dropdownProviderIds.find(id => String(id) === MITTR_PROVIDER_ID);
      if (provider) void useQuotaStore.getState().fetchProviderQuota(provider);
      else void quota.load();
    };
    const accountChanged = () => {
      coordinator.dispose();
      coordinator = make();
      active = coordinator;
      useQuotaStore.getState().invalidateProvider(MITTR_PROVIDER_ID);
      lastRevalidation = 0;
      refreshVisible();
    };
    const stopAccount = watchSignedInAccount(accountChanged);
    const stopRuntime = subscribeRuntimeEndpointChanged(accountChanged);
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    refreshVisible();
    return () => {
      unregister();
      stopAccount();
      stopRuntime();
      stopQuota();
      coordinator.dispose();
      if (active === coordinator) active = null;
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, []);
  return null;
}

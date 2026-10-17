import React from 'react';
import type { JsonValue } from '@openchamber/sdk';
import { z } from 'zod';

import { runtimeFetch } from '../../../ui/src/lib/runtime-fetch';
import type { ModelPickerDecorations } from '../../../ui/src/lib/product-plugins';

export const PROVIDER_LOCK_ENDPOINT = '/api/mittr/provider-lock';
const PROVIDER_LOCK_CHANGED_EVENT = 'mittr.provider-lock.changed';
const MITTR_PROVIDER_ID = 'mittr';

export type ProviderLock = { showOtherProviders: boolean };
type ProviderLockSnapshot = ProviderLock & { known: boolean };
export type SaveOutcome = 'saved' | 'not-applied' | 'failed';

export type LockResponse = { ok: boolean; status: number; json: () => Promise<JsonValue> };
export type LockFetch = (
  path: string,
  init?: { method?: 'PUT'; headers?: Record<string, string>; body?: string },
) => Promise<LockResponse>;

export type ProviderLockDeps = {
  fetch: LockFetch;
  // Hears that the switch changed somewhere else; each one re-reads it.
  subscribe: (onChange: () => void) => () => void;
  // Tells the others that this one changed it.
  announce: () => void;
};

export type ProviderLockBinding = { snapshot: ProviderLockSnapshot; controller: ProviderLockController };

export type ProviderLockController = {
  snapshot: () => ProviderLockSnapshot;
  subscribe: (listener: () => void) => () => void;
  refresh: () => Promise<void>;
  save: (showOtherProviders: boolean) => Promise<SaveOutcome>;
  dispose: () => void;
};

const lockPayload = z.object({ showOtherProviders: z.boolean() });

const parseLock = (payload: JsonValue): ProviderLock | null => {
  const parsed = lockPayload.safeParse(payload);
  return parsed.success ? { showOtherProviders: parsed.data.showOtherProviders } : null;
};

// Until the server has answered, other providers stay hidden: the engine is
// locked to Mittr unless the person turned the switch on.
const UNKNOWN: ProviderLockSnapshot = { showOtherProviders: false, known: false };

/**
 * The person's provider switch, as the server stores it. It is read when
 * asked (the model picker asks each time it opens) and again whenever
 * `subscribe` says it changed elsewhere. A read that fails keeps what was
 * known; the newest read wins over an older one that answers late.
 */
export function createProviderLockController({ fetch, subscribe, announce }: ProviderLockDeps): ProviderLockController {
  let current = UNKNOWN;
  let disposed = false;
  let latestRead = 0;
  const listeners = new Set<() => void>();

  const show = (lock: ProviderLock) => {
    if (disposed) return;
    current = { showOtherProviders: lock.showOtherProviders, known: true };
    for (const listener of listeners) listener();
  };

  const refresh = async () => {
    const read = ++latestRead;
    try {
      const response = await fetch(PROVIDER_LOCK_ENDPOINT);
      if (!response.ok) return;
      const lock = parseLock(await response.json());
      if (lock && read === latestRead) show(lock);
    } catch {
      // The last known value stands; the next open reads again.
    }
  };

  // A save the server stored but the engine has not taken up yet answers 500
  // with the stored value, which is what the switch shows.
  const save = async (showOtherProviders: boolean): Promise<SaveOutcome> => {
    latestRead += 1;
    let stored: ProviderLock | null = null;
    let ok = false;
    try {
      const response = await fetch(PROVIDER_LOCK_ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ showOtherProviders }),
      });
      ok = response.ok;
      stored = parseLock(await response.json().catch(() => null));
    } catch {
      stored = null;
    }
    if (!stored) {
      await refresh();
      return 'failed';
    }
    show(stored);
    announce();
    return ok ? 'saved' : 'not-applied';
  };

  const stop = subscribe(() => { void refresh(); });

  return {
    snapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh,
    save,
    dispose: () => {
      disposed = true;
      listeners.clear();
      stop();
    },
  };
}

export function mittrPickerDecorations({ showOtherProviders }: ProviderLock): ModelPickerDecorations {
  return {
    isProviderShown: (providerId) => showOtherProviders || providerId === MITTR_PROVIDER_ID,
    entryStatus: () => null,
    offersAddProvider: showOtherProviders,
  };
}

// The app's other windows (the mini chat) are on the same origin, so a
// broadcast channel reaches them; a client on another machine reads the
// switch again the next time its picker opens.
const openChannel = (): BroadcastChannel | null =>
  'BroadcastChannel' in globalThis ? new BroadcastChannel(PROVIDER_LOCK_CHANGED_EVENT) : null;

let shared: ProviderLockController | null = null;

const sharedController = (): ProviderLockController => {
  if (shared) return shared;
  const channel = openChannel();
  shared = createProviderLockController({
    fetch: (path, init) => runtimeFetch(path, init),
    subscribe: (onChange) => {
      if (!channel) return () => {};
      channel.onmessage = onChange;
      return () => { channel.onmessage = null; };
    },
    announce: () => channel?.postMessage(PROVIDER_LOCK_CHANGED_EVENT),
  });
  return shared;
};

export function useProviderLock(): ProviderLockBinding {
  const controller = sharedController();
  const snapshot = React.useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  return { snapshot, controller };
}

export function useMittrPickerFilter(open: boolean): ProviderLock {
  const { snapshot, controller } = useProviderLock();
  React.useEffect(() => {
    if (open) void controller.refresh();
  }, [controller, open]);
  return { showOtherProviders: snapshot.showOtherProviders };
}

export function useMittrPickerDecorations(open: boolean): ModelPickerDecorations {
  const { showOtherProviders } = useMittrPickerFilter(open);
  return React.useMemo(() => mittrPickerDecorations({ showOtherProviders }), [showOtherProviders]);
}

import React from 'react';
import type { JsonValue } from '@openchamber/sdk';
import { z } from 'zod';

import { runtimeFetch } from '../../../ui/src/lib/runtime-fetch';
import { ownEntriesSchema } from '../../../ui/src/lib/quota/ownEntries';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '../../../ui/src/lib/runtime-switch';
import { signedInAccount, watchSignedInAccount } from '../sign-in/signedInAccount';

export const QUOTA_ME_ENDPOINT = '/api/mittr/quota/me';
export const QUOTA_ME_FRESH_MS = 30_000;

const time = z.string().refine((value) => !Number.isNaN(Date.parse(value)));
const amount = z.number().min(0);

const agentStatusSchema = z.object({
  modelKey: z.string(),
  left: amount,
  limit: amount,
  resetsAt: time,
  state: z.enum(['ok', 'near', 'substitute', 'out']),
  percentLeft: amount.optional().catch(undefined),
  substituteLabel: z.string().optional().catch(undefined),
  maySubstitute: z.literal(true).optional(),
});

const chatLineSchema = z.object({
  modelKey: z.string(),
  kind: z.literal('chat'),
  used: amount,
  limit: z.number().positive(),
  agents: z.array(z.object({ key: z.string() })).optional().catch(undefined),
});

const NEAR_USED_SHARE = 0.8;

const quotaMeSchema = z.object({
  weekStart: time,
  resetsAt: time,
  lines: z.array(z.json()),
  agentStatus: ownEntriesSchema(z.json()).optional().catch(undefined),
});

export type AgentStatus = z.infer<typeof agentStatusSchema>;

export type QuotaMe = { agentStatus: ReadonlyMap<string, AgentStatus> };

export type QuotaMeState =
  | { status: 'idle' }
  | { status: 'ok'; quota: QuotaMe }
  | { status: 'unavailable' };

export type QuotaMeResponse = { ok: boolean; json: () => Promise<JsonValue> };
export type QuotaMeFetch = (path: string, options?: { signal?: AbortSignal }) => Promise<QuotaMeResponse>;

const statusOfLine = ({ modelKey, used, limit }: z.infer<typeof chatLineSchema>, resetsAt: string): AgentStatus => {
  const left = Math.max(0, limit - used);
  const base = { modelKey, left, limit, resetsAt };
  if (used < limit * NEAR_USED_SHARE) return { ...base, state: 'ok' };
  if (used < limit) return { ...base, state: 'near', percentLeft: Math.max(1, Math.floor((left / limit) * 100)) };
  return { ...base, state: 'out', maySubstitute: true };
};

export function parseQuotaMe(payload: JsonValue): QuotaMe | null {
  const parsed = quotaMeSchema.safeParse(payload);
  if (!parsed.success) return null;
  const agentStatus = new Map<string, AgentStatus>();
  for (const [alias, raw] of parsed.data.agentStatus ?? []) {
    const status = agentStatusSchema.safeParse(raw);
    if (status.success) agentStatus.set(alias, status.data);
  }
  const lines = parsed.data.lines.flatMap(raw => {
    const line = chatLineSchema.safeParse(raw);
    return line.success ? [line.data] : [];
  });
  for (const line of lines) {
    const status = statusOfLine(line, parsed.data.resetsAt);
    for (const member of line.agents ?? []) {
      if (!agentStatus.has(member.key)) agentStatus.set(member.key, status);
    }
  }
  for (const line of lines) {
    if (!agentStatus.has(line.modelKey)) agentStatus.set(line.modelKey, statusOfLine(line, parsed.data.resetsAt));
  }
  return { agentStatus };
}

export type QuotaMeController = {
  snapshot: () => QuotaMeState;
  subscribe: (listener: () => void) => () => void;
  load: (options?: { force?: boolean }) => Promise<void>;
};

const IDLE: QuotaMeState = { status: 'idle' };
const UNAVAILABLE: QuotaMeState = { status: 'unavailable' };

type QuotaMeDeps = {
  fetch: QuotaMeFetch;
  now?: () => number;
  account?: () => string | null;
  watchAccount?: (listener: () => void) => () => void;
  runtime?: () => string;
  watchRuntime?: (listener: () => void) => () => void;
};

type CachedQuotaMe = { state: QuotaMeState; loadedAt: number };

export function createQuotaMeController({
  fetch,
  now = Date.now,
  account = () => null,
  watchAccount = () => () => {},
  runtime = () => '',
  watchRuntime = () => () => {},
}: QuotaMeDeps): QuotaMeController {
  const cached = new Map<string, CachedQuotaMe>();
  let pending: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let generation = 0;
  const ownerKey = () => JSON.stringify([runtime(), account()]);
  let owner = ownerKey();
  const listeners = new Set<() => void>();
  const reconcileOwner = () => {
    const next = ownerKey();
    if (next === owner) return;
    owner = next;
    generation += 1;
    controller?.abort();
    controller = null;
    pending = null;
  };

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const read = async (signal: AbortSignal): Promise<QuotaMeState> => {
    try {
      const response = await fetch(QUOTA_ME_ENDPOINT, { signal });
      if (!response.ok) return UNAVAILABLE;
      const quota = parseQuotaMe(await response.json());
      return quota ? { status: 'ok', quota } : UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  };

  const load = ({ force = false }: { force?: boolean } = {}): Promise<void> => {
    reconcileOwner();
    if (pending) return pending;
    const key = owner;
    const revision = generation;
    const known = cached.get(key);
    if (!force && known && now() - known.loadedAt < QUOTA_ME_FRESH_MS) {
      return Promise.resolve();
    }
    controller = new AbortController();
    const loading = read(controller.signal)
      .then((state) => {
        reconcileOwner();
        if (revision !== generation) return;
        cached.set(key, { state, loadedAt: now() });
        notify();
      })
      .finally(() => {
        if (revision === generation) { pending = null; controller = null; }
      });
    pending = loading;
    return loading;
  };

  return {
    snapshot: () => { reconcileOwner(); return cached.get(owner)?.state ?? IDLE; },
    subscribe: (listener) => {
      listeners.add(listener);
      const changed = () => { reconcileOwner(); listener(); };
      const stopWatching = watchAccount(changed);
      const stopRuntime = watchRuntime(changed);
      return () => {
        listeners.delete(listener);
        stopWatching();
        stopRuntime();
        if (listeners.size === 0) {
          generation += 1;
          controller?.abort();
          controller = null;
          pending = null;
        }
      };
    },
    load,
  };
}

let shared: QuotaMeController | null = null;

export const sharedQuotaMeController = (): QuotaMeController => {
  shared ??= createQuotaMeController({
    fetch: (path, options) => runtimeFetch(path, options),
    account: signedInAccount,
    watchAccount: watchSignedInAccount,
    runtime: getRuntimeKey,
    watchRuntime: subscribeRuntimeEndpointChanged,
  });
  return shared;
};

export function useQuotaMe(open: boolean): QuotaMeState {
  const controller = sharedQuotaMeController();
  const state = React.useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const owner = React.useSyncExternalStore(watchSignedInAccount, signedInAccount, signedInAccount);
  React.useEffect(() => {
    if (open) void controller.load();
  }, [controller, open, owner]);
  return state;
}

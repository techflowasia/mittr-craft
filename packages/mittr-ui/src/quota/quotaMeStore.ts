import React from 'react';
import type { JsonValue } from '@openchamber/sdk';
import { z } from 'zod';

import { runtimeFetch } from '../../../ui/src/lib/runtime-fetch';

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
});

const quotaMeSchema = z.object({
  weekStart: time,
  resetsAt: time,
  lines: z.array(z.json()),
  agentStatus: z.record(z.string(), z.json()).optional().catch(undefined),
});

export type AgentStatus = z.infer<typeof agentStatusSchema>;

export type QuotaMe = { agentStatus: ReadonlyMap<string, AgentStatus> };

export type QuotaMeState =
  | { status: 'idle' }
  | { status: 'ok'; quota: QuotaMe }
  | { status: 'unavailable' };

export type QuotaMeResponse = { ok: boolean; json: () => Promise<JsonValue> };
export type QuotaMeFetch = (path: string) => Promise<QuotaMeResponse>;

export function parseQuotaMe(payload: JsonValue): QuotaMe | null {
  const parsed = quotaMeSchema.safeParse(payload);
  if (!parsed.success) return null;
  const agentStatus = new Map<string, AgentStatus>();
  for (const [alias, raw] of Object.entries(parsed.data.agentStatus ?? {})) {
    const status = agentStatusSchema.safeParse(raw);
    if (status.success) agentStatus.set(alias, status.data);
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

export function createQuotaMeController({ fetch, now = Date.now }: { fetch: QuotaMeFetch; now?: () => number }): QuotaMeController {
  let current = IDLE;
  let loadedAt: number | null = null;
  let pending: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: QuotaMeState) => {
    current = next;
    for (const listener of listeners) listener();
  };

  const read = async (): Promise<QuotaMeState> => {
    try {
      const response = await fetch(QUOTA_ME_ENDPOINT);
      if (!response.ok) return UNAVAILABLE;
      const quota = parseQuotaMe(await response.json());
      return quota ? { status: 'ok', quota } : UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  };

  const load = ({ force = false }: { force?: boolean } = {}): Promise<void> => {
    if (pending) return pending;
    if (!force && loadedAt !== null && now() - loadedAt < QUOTA_ME_FRESH_MS) {
      return Promise.resolve();
    }
    pending = read()
      .then((next) => {
        loadedAt = now();
        publish(next);
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  return {
    snapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load,
  };
}

let shared: QuotaMeController | null = null;

const sharedController = (): QuotaMeController => {
  shared ??= createQuotaMeController({ fetch: (path) => runtimeFetch(path) });
  return shared;
};

export function useQuotaMe(open: boolean): QuotaMeState {
  const controller = sharedController();
  const state = React.useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  React.useEffect(() => {
    if (open) void controller.load();
  }, [controller, open]);
  return state;
}

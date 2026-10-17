import type { JsonValue } from '@openchamber/sdk';
import { z } from 'zod';

import { runtimeFetch } from '../../../ui/src/lib/runtime-fetch';

export const AD_STATUS_ENDPOINT = '/auth/ad/status';

export type AdMode = 'ldap' | 'entra';

export type AdStatus = {
  enabled: boolean;
  mode?: AdMode;
  passwordEnabled: boolean;
  tunnelLocked: boolean;
};

export type AdResponse = { ok: boolean; status: number; json: () => Promise<JsonValue> };
export type AdFetch = (path: string, init?: RequestInit) => Promise<AdResponse>;

export const defaultAdFetch: AdFetch = (path, init) => runtimeFetch(path, init);

export const JSON_CREDENTIALS_INIT = {
  credentials: 'include',
  cache: 'no-store',
  headers: { Accept: 'application/json' },
} as const satisfies RequestInit;

const statusPayload = z.object({
  enabled: z.boolean().catch(false),
  mode: z.enum(['ldap', 'entra']).optional().catch(undefined),
  passwordEnabled: z.boolean().catch(true),
  tunnelLocked: z.boolean().catch(false),
});

const unavailable = (tunnelLocked: boolean): AdStatus => ({ enabled: false, passwordEnabled: true, tunnelLocked });

export async function fetchAdStatus(fetch: AdFetch = defaultAdFetch): Promise<AdStatus> {
  try {
    const response = await fetch(AD_STATUS_ENDPOINT, JSON_CREDENTIALS_INIT);
    if (!response.ok) return unavailable(response.status === 403);
    const parsed = statusPayload.parse(await response.json());
    if (!parsed.enabled || parsed.mode === undefined) return unavailable(parsed.tunnelLocked);
    return { enabled: true, mode: parsed.mode, passwordEnabled: parsed.passwordEnabled, tunnelLocked: parsed.tunnelLocked };
  } catch {
    return unavailable(false);
  }
}

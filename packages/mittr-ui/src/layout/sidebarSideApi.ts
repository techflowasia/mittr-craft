import type { JsonValue } from '@openchamber/sdk';
import { z } from 'zod';

import { runtimeFetch } from '../../../ui/src/lib/runtime-fetch';
import { errorTextOf, readJsonReply } from '../errorReply';
import { mittrT } from '../strings/mittrT';

export const APPEARANCE_SETTINGS_ENDPOINT = '/api/mittr/appearance/settings';

export const SIDEBAR_SIDES = ['left', 'right'] as const;

const settingsPayload = z.object({
  sidebarSide: z.enum(SIDEBAR_SIDES),
  canChange: z.boolean(),
});

export type SidebarSideSettings = z.infer<typeof settingsPayload>;

export type SidebarSide = SidebarSideSettings['sidebarSide'];

type SidebarSideResponse = { ok: boolean; status: number; json: () => Promise<JsonValue> };

export type SidebarSideFetch = (
  path: string,
  init?: { method: string; headers?: Record<string, string>; body?: string },
) => Promise<SidebarSideResponse>;

export type SidebarSideApi = {
  load(): Promise<SidebarSideSettings>;
  save(side: SidebarSide): Promise<SidebarSideSettings>;
};

export class SidebarSideRequestError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'SidebarSideRequestError';
    this.status = status;
  }
}

export function createSidebarSideApi(fetchImpl: SidebarSideFetch = runtimeFetch): SidebarSideApi {
  const request = async (init: Parameters<SidebarSideFetch>[1], fallback: string): Promise<SidebarSideSettings> => {
    let response: SidebarSideResponse;
    try {
      response = await fetchImpl(APPEARANCE_SETTINGS_ENDPOINT, init);
    } catch {
      throw new SidebarSideRequestError(fallback, null);
    }
    const body = await readJsonReply(response);
    if (!response.ok) throw new SidebarSideRequestError(errorTextOf(body, fallback), response.status);
    const parsed = settingsPayload.safeParse(body);
    if (!parsed.success) throw new SidebarSideRequestError(fallback, response.status);
    return parsed.data;
  };

  return {
    load: () => request({ method: 'GET' }, mittrT('mittr.sidebarSide.errors.loadFailed')),
    save: (side) => request(
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sidebarSide: side }) },
      mittrT('mittr.sidebarSide.errors.saveFailed'),
    ),
  };
}

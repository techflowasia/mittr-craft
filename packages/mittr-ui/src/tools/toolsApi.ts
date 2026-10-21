import type { JsonValue } from '@openchamber/sdk';
import { z } from 'zod';

import { runtimeFetch } from '../../../ui/src/lib/runtime-fetch';
import { errorTextOf, readJsonReply } from '../errorReply';
import { mittrT } from '../strings/mittrT';

const TOOLS_ENDPOINT = '/api/mittr/tools';
const PROFILES_ENDPOINT = `${TOOLS_ENDPOINT}/chrome/profiles`;
const HOSTS_ENDPOINT = `${TOOLS_ENDPOINT}/chrome/approved-hosts`;

const computerPayload = z.object({ offered: z.boolean(), enabled: z.boolean() });

const chromePayload = z.object({
  offered: z.boolean(),
  chromeInstalled: z.boolean(),
  enabled: z.boolean(),
  profile: z.string().nullable(),
  headed: z.boolean(),
  approvedHosts: z.array(z.string()),
});

const toolsPayload = z.object({ computer: computerPayload, chrome: chromePayload, canChange: z.boolean() });

const profilePayload = z.object({ directory: z.string().min(1), name: z.string() });

const profilesPayload = z.object({ profiles: z.array(profilePayload) });

const hostsPayload = z.object({ hosts: z.array(z.string()) });

export type MittrTools = z.infer<typeof toolsPayload>;

export type ChromeProfile = z.infer<typeof profilePayload>;

export type ToolsPatch = { computer?: boolean; chrome?: boolean; chromeProfile?: string; chromeHeaded?: boolean };

type ToolsResponse = { ok: boolean; status: number; json: () => Promise<JsonValue> };

export type ToolsFetch = (
  path: string,
  init?: { method: string; headers?: Record<string, string>; body?: string },
) => Promise<ToolsResponse>;

export type ToolsApi = {
  load(): Promise<MittrTools>;
  save(patch: ToolsPatch): Promise<MittrTools>;
  profiles(): Promise<ChromeProfile[]>;
  removeHost(host: string): Promise<string[]>;
};

export class ToolsRequestError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'ToolsRequestError';
    this.status = status;
  }
}

export function createToolsApi(fetchImpl: ToolsFetch = runtimeFetch): ToolsApi {
  const request = async <T>(
    path: string,
    init: Parameters<ToolsFetch>[1],
    schema: z.ZodType<T>,
    fallback: string,
  ): Promise<T> => {
    let response: ToolsResponse;
    try {
      response = await fetchImpl(path, init);
    } catch {
      throw new ToolsRequestError(fallback, null);
    }
    const body = await readJsonReply(response);
    if (!response.ok) throw new ToolsRequestError(errorTextOf(body, fallback), response.status);
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ToolsRequestError(fallback, response.status);
    return parsed.data;
  };

  return {
    load: () => request(TOOLS_ENDPOINT, { method: 'GET' }, toolsPayload, mittrT('mittr.tools.errors.loadFailed')),
    save: (patch) => request(
      TOOLS_ENDPOINT,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) },
      toolsPayload,
      mittrT('mittr.tools.errors.saveFailed'),
    ),
    profiles: async () => (await request(PROFILES_ENDPOINT, { method: 'GET' }, profilesPayload, mittrT('mittr.tools.errors.profilesFailed'))).profiles,
    removeHost: async (host) => (await request(
      `${HOSTS_ENDPOINT}/${encodeURIComponent(host)}`,
      { method: 'DELETE' },
      hostsPayload,
      mittrT('mittr.tools.errors.removeFailed', { host }),
    )).hosts,
  };
}

import type { JsonValue } from '@openchamber/sdk';
import { z } from 'zod';

import { runtimeFetch } from '../../../ui/src/lib/runtime-fetch';
import { mittrT } from '../strings/mittrT';

const INTEGRATIONS_ENDPOINT = '/api/mittr/integrations';

export type JiraConfig = { baseUrl: string; email: string; hasToken: boolean; configured: boolean };

export type PlaneConfig = {
  baseUrl: string;
  workspaceSlug: string;
  workspaceSlugs?: string[];
  hasApiKey: boolean;
  configured: boolean;
};

export type IntegrationsConfig = { jira: JiraConfig; plane: PlaneConfig; userId: string | null };

export type PlaneWorkspaceTest = { slug: string; ok: boolean; count: number; error?: string };

export type IntegrationTestResult = {
  ok: boolean;
  error?: string;
  displayName?: string;
  email?: string;
  count?: number;
  workspaces?: PlaneWorkspaceTest[];
  userId?: string | null;
};

export type IntegrationsSaveBody = {
  expectUserId: string;
  jira?: { baseUrl: string; email: string; token?: string };
  plane?: { baseUrl: string; workspaceSlug: string; workspaceSlugs: string[]; apiKey?: string };
};

type IntegrationsResponse = { ok: boolean; status: number; json: () => Promise<JsonValue> };

export type IntegrationsFetch = (
  path: string,
  init?: { method: string; headers?: Record<string, string>; body?: string },
) => Promise<IntegrationsResponse>;

export type IntegrationsApi = {
  load(): Promise<IntegrationsConfig>;
  save(body: IntegrationsSaveBody): Promise<IntegrationsConfig>;
  testJira(): Promise<IntegrationTestResult>;
  testPlane(): Promise<IntegrationTestResult>;
};

export class IntegrationsRequestError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'IntegrationsRequestError';
    this.status = status;
  }
}

const text = z.string().catch('');
const flag = z.boolean().catch(false);
const optionalText = z.string().optional().catch(undefined);

const jiraPayload = z.object({ baseUrl: text, email: text, hasToken: flag, configured: flag });

const planePayload = z.object({
  baseUrl: text,
  workspaceSlug: text,
  workspaceSlugs: z.array(z.string()).optional().catch(undefined),
  hasApiKey: flag,
  configured: flag,
});

const configPayload = z.object({
  jira: jiraPayload.optional().catch(undefined),
  plane: planePayload.optional().catch(undefined),
  userId: z.string().nullable().catch(null),
});

const workspaceTestPayload = z.object({
  slug: z.string(),
  ok: z.boolean(),
  count: z.number().catch(0),
  error: optionalText,
});

const testPayload = z.object({
  ok: flag,
  error: optionalText,
  displayName: optionalText,
  email: optionalText,
  count: z.number().optional().catch(undefined),
  workspaces: z.array(workspaceTestPayload.nullable().catch(null)).optional().catch(undefined),
  userId: z.string().nullable().optional().catch(undefined),
});

const errorPayload = z.object({ error: z.string().refine((value) => value.trim().length > 0) });

const EMPTY_JIRA: JiraConfig = { baseUrl: '', email: '', hasToken: false, configured: false };
const EMPTY_PLANE: PlaneConfig = { baseUrl: '', workspaceSlug: '', hasApiKey: false, configured: false };

const readJson = async (response: IntegrationsResponse): Promise<JsonValue | undefined> => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

const failureText = (body: JsonValue | undefined, fallback: string): string => {
  const parsed = errorPayload.safeParse(body);
  return parsed.success ? parsed.data.error : fallback;
};

const planeOf = ({ workspaceSlugs, ...rest }: z.infer<typeof planePayload>): PlaneConfig =>
  (workspaceSlugs ? { ...rest, workspaceSlugs } : rest);

const readConfig = (body: JsonValue | undefined): IntegrationsConfig | null => {
  const parsed = configPayload.safeParse(body);
  if (!parsed.success) return null;
  const { jira, plane, userId } = parsed.data;
  return { jira: jira ?? EMPTY_JIRA, plane: plane ? planeOf(plane) : EMPTY_PLANE, userId };
};

const workspaceTestOf = ({ error, ...rest }: z.infer<typeof workspaceTestPayload>): PlaneWorkspaceTest =>
  (error === undefined ? rest : { ...rest, error });

const readTest = (body: JsonValue | undefined): IntegrationTestResult | null => {
  const parsed = testPayload.safeParse(body);
  if (!parsed.success) return null;
  const result: IntegrationTestResult = { ok: parsed.data.ok };
  const { error, displayName, email, count, workspaces, userId } = parsed.data;
  if (error !== undefined) result.error = error;
  if (displayName !== undefined) result.displayName = displayName;
  if (email !== undefined) result.email = email;
  if (count !== undefined) result.count = count;
  if (workspaces !== undefined) result.workspaces = workspaces.flatMap((entry) => (entry ? [workspaceTestOf(entry)] : []));
  if (userId !== undefined) result.userId = userId;
  return result;
};

export function createIntegrationsApi(fetchImpl: IntegrationsFetch = runtimeFetch): IntegrationsApi {
  const request = async (
    path: string,
    init: Parameters<IntegrationsFetch>[1],
    fallback: string,
  ): Promise<IntegrationsConfig> => {
    let response: IntegrationsResponse;
    try {
      response = await fetchImpl(path, init);
    } catch {
      throw new IntegrationsRequestError(fallback, null);
    }
    const body = await readJson(response);
    if (!response.ok) throw new IntegrationsRequestError(failureText(body, fallback), response.status);
    const config = readConfig(body);
    if (!config) throw new IntegrationsRequestError(fallback, response.status);
    return config;
  };

  const runTest = async (platform: 'jira' | 'plane'): Promise<IntegrationTestResult> => {
    const fallback = mittrT('mittr.workTracking.toast.testFailed');
    let response: IntegrationsResponse;
    try {
      response = await fetchImpl(`${INTEGRATIONS_ENDPOINT}/${platform}/test`, { method: 'POST' });
    } catch {
      return { ok: false, error: fallback };
    }
    const body = await readJson(response);
    if (!response.ok) return { ok: false, error: failureText(body, fallback) };
    return readTest(body) ?? { ok: false, error: fallback };
  };

  return {
    load: () => request(INTEGRATIONS_ENDPOINT, { method: 'GET' }, mittrT('mittr.workTracking.errors.loadFailed')),
    save: (body) => request(
      INTEGRATIONS_ENDPOINT,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      mittrT('mittr.workTracking.toast.saveFailed'),
    ),
    testJira: () => runTest('jira'),
    testPlane: () => runTest('plane'),
  };
}

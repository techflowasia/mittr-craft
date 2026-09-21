import { runtimeFetch } from './runtime-fetch';

export type MittrJiraConfig = {
  baseUrl: string;
  email: string;
  hasToken: boolean;
  configured: boolean;
};

export type MittrPlaneConfig = {
  baseUrl: string;
  workspaceSlug: string;
  hasApiKey: boolean;
  configured: boolean;
};

export type MittrIntegrationsConfig = {
  jira: MittrJiraConfig;
  plane: MittrPlaneConfig;
};

export type MittrTestResult = {
  ok: boolean;
  error?: string;
  displayName?: string;
  email?: string;
  count?: number;
};

const parseErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed.error === 'string' && parsed.error.trim().length > 0) {
      return parsed.error;
    }
  } catch {
    return fallback;
  }
  return fallback;
};

export const fetchMittrIntegrations = async (): Promise<MittrIntegrationsConfig> => {
  const response = await runtimeFetch('/api/mittr/integrations');
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to load integration settings'));
  }
  return response.json();
};

export const saveMittrIntegrations = async (
  input: { jira?: Partial<{ baseUrl: string; email: string; token: string }>; plane?: Partial<{ baseUrl: string; workspaceSlug: string; apiKey: string }> },
): Promise<MittrIntegrationsConfig> => {
  const response = await runtimeFetch('/api/mittr/integrations', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to save integration settings'));
  }
  return response.json();
};

export const testMittrJira = async (): Promise<MittrTestResult> => {
  const response = await runtimeFetch('/api/mittr/integrations/jira/test', { method: 'POST' });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) {
    return { ok: false, error: await parseErrorMessage(response, 'Test failed') };
  }
  return parsed ?? { ok: false, error: 'Test failed' };
};

export const testMittrPlane = async (): Promise<MittrTestResult> => {
  const response = await runtimeFetch('/api/mittr/integrations/plane/test', { method: 'POST' });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) {
    return { ok: false, error: await parseErrorMessage(response, 'Test failed') };
  }
  return parsed ?? { ok: false, error: 'Test failed' };
};

import { mittrT } from '../strings/mittrT';
import type { IntegrationsConfig, IntegrationsSaveBody, JiraConfig, PlaneConfig } from './integrationsApi';

export const KEEP_PLACEHOLDER = '••••••••••••';

export const MAX_WORKSPACES = 20;

export const MAX_SLUG_LENGTH = 100;

export type JiraForm = { baseUrl: string; email: string; token: string };

export type PlaneForm = { baseUrl: string; workspaceSlugs: string[]; apiKey: string };

type WorkspaceRefusal =
  | { error: 'empty' }
  | { error: 'duplicate'; slug: string }
  | { error: 'limit' }
  | { error: 'tooLong' };

export function slugFromInput(value: string): string {
  const text = value.trim();
  const fromUrl = /^https?:\/\/[^/]+\/([^/?#]+)/i.exec(text);
  return (fromUrl?.[1] ?? (/^https?:\/\//i.test(text) ? '' : text)).replace(/^\/+|\/+$/g, '');
}

export function slugsOf(plane: Pick<PlaneConfig, 'workspaceSlug' | 'workspaceSlugs'>): string[] {
  if (plane.workspaceSlugs?.length) return [...plane.workspaceSlugs];
  return plane.workspaceSlug ? [plane.workspaceSlug] : [];
}

export function multiWorkspaceSupported(config: Pick<IntegrationsConfig, 'plane'>): boolean {
  return Array.isArray(config.plane.workspaceSlugs);
}

export function workspaceLimitOf(config: Pick<IntegrationsConfig, 'plane'>): number {
  return multiWorkspaceSupported(config) ? MAX_WORKSPACES : 1;
}

export function jiraFormOf(jira: JiraConfig): JiraForm {
  return { baseUrl: jira.baseUrl, email: jira.email, token: '' };
}

export function planeFormOf(plane: PlaneConfig): PlaneForm {
  return { baseUrl: plane.baseUrl, workspaceSlugs: slugsOf(plane), apiKey: '' };
}

export function addWorkspace(
  list: readonly string[],
  input: string,
  limit: number = MAX_WORKSPACES,
): { list: string[] } | WorkspaceRefusal {
  const slug = slugFromInput(input);
  if (!slug) return { error: 'empty' };
  if (list.includes(slug)) return { error: 'duplicate', slug };
  if (slug.length > MAX_SLUG_LENGTH) return { error: 'tooLong' };
  if (list.length >= limit) return { error: 'limit' };
  return { list: [...list, slug] };
}

export function workspaceRefusalText(refusal: WorkspaceRefusal, limit: number = MAX_WORKSPACES): string {
  switch (refusal.error) {
    case 'empty':
      return mittrT('mittr.workTracking.plane.workspaceEmpty');
    case 'duplicate':
      return mittrT('mittr.workTracking.plane.duplicateWorkspace', { slug: refusal.slug });
    case 'tooLong':
      return mittrT('mittr.workTracking.plane.workspaceTooLong', { max: MAX_SLUG_LENGTH });
    case 'limit':
      return limit === 1
        ? mittrT('mittr.workTracking.plane.singleWorkspace')
        : mittrT('mittr.workTracking.plane.workspaceLimit', { max: limit });
  }
}

export function jiraSaveBody(form: JiraForm, expectUserId: string): IntegrationsSaveBody {
  return {
    jira: { baseUrl: form.baseUrl, email: form.email, ...(form.token ? { token: form.token } : {}) },
    expectUserId,
  };
}

export function planeSaveBody(form: PlaneForm, expectUserId: string): IntegrationsSaveBody {
  return {
    plane: {
      baseUrl: form.baseUrl,
      workspaceSlug: form.workspaceSlugs[0] ?? '',
      workspaceSlugs: [...form.workspaceSlugs],
      ...(form.apiKey ? { apiKey: form.apiKey } : {}),
    },
    expectUserId,
  };
}

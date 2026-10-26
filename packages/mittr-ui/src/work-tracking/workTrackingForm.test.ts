import { describe, expect, test } from 'bun:test';

import { mittrT } from '../strings/mittrT';
import type { IntegrationsConfig, PlaneConfig } from './integrationsApi';
import {
  addWorkspace,
  jiraFormOf,
  jiraSaveBody,
  KEEP_PLACEHOLDER,
  MAX_SLUG_LENGTH,
  MAX_WORKSPACES,
  multiWorkspaceSupported,
  planeFormOf,
  planeSaveBody,
  slugFromInput,
  slugsOf,
  workspaceRefusalText,
} from './workTrackingForm';

const plane = (overrides: Partial<PlaneConfig> = {}): PlaneConfig => ({
  baseUrl: 'https://plane.example.com',
  workspaceSlug: 'alpha',
  hasApiKey: true,
  configured: true,
  ...overrides,
});

const config = (planeOverrides: Partial<PlaneConfig> = {}): IntegrationsConfig => ({
  jira: { baseUrl: 'https://acme.atlassian.net', email: 'a@acme.test', hasToken: true, configured: true },
  plane: plane(planeOverrides),
  userId: 'u-a',
});

describe('work tracking form', () => {
  test('a pasted workspace URL gives its slug', () => {
    expect(slugFromInput('https://plane.example.com/techflow/projects')).toBe('techflow');
    expect(slugFromInput('  https://plane.example.com/techflow  ')).toBe('techflow');
    expect(slugFromInput('/techflow/')).toBe('techflow');
    expect(slugFromInput('techflow')).toBe('techflow');
    expect(slugFromInput('   ')).toBe('');
  });

  test('the workspace list comes from workspaceSlugs, else the one saved slug', () => {
    expect(slugsOf(plane({ workspaceSlugs: ['alpha', 'beta'] }))).toEqual(['alpha', 'beta']);
    expect(slugsOf(plane({ workspaceSlugs: [] }))).toEqual(['alpha']);
    expect(slugsOf(plane())).toEqual(['alpha']);
    expect(slugsOf(plane({ workspaceSlug: '' }))).toEqual([]);
  });

  test('several workspaces are offered only when the platform answers workspaceSlugs', () => {
    expect(multiWorkspaceSupported(config({ workspaceSlugs: [] }))).toBe(true);
    expect(multiWorkspaceSupported(config())).toBe(false);
  });

  test('a workspace is added once, by its slug', () => {
    expect(addWorkspace(['alpha'], 'https://plane.example.com/beta/projects')).toEqual({ list: ['alpha', 'beta'] });
    expect(addWorkspace([], 'beta')).toEqual({ list: ['beta'] });
  });

  test('a duplicate workspace is refused', () => {
    expect(addWorkspace(['alpha'], 'https://plane.example.com/alpha')).toEqual({ error: 'duplicate', slug: 'alpha' });
    expect(workspaceRefusalText({ error: 'duplicate', slug: 'alpha' })).toBe('alpha is already in the list');
  });

  test('an empty workspace, a 21st and a slug over 100 characters are refused, each with its own text', () => {
    expect(addWorkspace(['alpha'], '  ')).toEqual({ error: 'empty' });
    expect(addWorkspace(['alpha'], 'https://plane.example.com/')).toEqual({ error: 'empty' });

    const twenty = Array.from({ length: MAX_WORKSPACES }, (_, index) => `ws-${index}`);
    expect(MAX_WORKSPACES).toBe(20);
    expect(addWorkspace(twenty, 'one-more')).toEqual({ error: 'limit' });
    expect(addWorkspace(twenty.slice(1), 'one-more')).toEqual({ list: [...twenty.slice(1), 'one-more'] });

    expect(MAX_SLUG_LENGTH).toBe(100);
    expect(addWorkspace([], 'x'.repeat(101))).toEqual({ error: 'tooLong' });
    expect(addWorkspace([], 'x'.repeat(100))).toEqual({ list: ['x'.repeat(100)] });

    const texts = (['empty', 'limit', 'tooLong'] as const).map((error) => workspaceRefusalText({ error }));
    expect(texts).toEqual([
      mittrT('mittr.workTracking.plane.workspaceEmpty'),
      'You can add up to 20 workspaces.',
      'A workspace name can be at most 100 characters.',
    ]);
    expect(new Set(texts).size).toBe(3);
  });

  test('the token and key fields start empty whatever the server says is saved', () => {
    expect(jiraFormOf(config().jira)).toEqual({ baseUrl: 'https://acme.atlassian.net', email: 'a@acme.test', token: '' });
    expect(planeFormOf(plane({ workspaceSlugs: ['alpha', 'beta'] }))).toEqual({ baseUrl: 'https://plane.example.com', workspaceSlugs: ['alpha', 'beta'], apiKey: '' });
    expect(KEEP_PLACEHOLDER).toBe('••••••••••••');
  });

  test('the Jira save sends the token only when one was typed', () => {
    expect(jiraSaveBody({ baseUrl: 'https://acme.atlassian.net', email: 'a@acme.test', token: '' }, 'u-a')).toEqual({
      jira: { baseUrl: 'https://acme.atlassian.net', email: 'a@acme.test' },
      expectUserId: 'u-a',
    });
    expect(jiraSaveBody({ baseUrl: 'b', email: 'e', token: 't' }, 'u-a').jira).toEqual({ baseUrl: 'b', email: 'e', token: 't' });
  });

  test('the Plane save keeps the first slug for older platforms', () => {
    expect(planeSaveBody({ baseUrl: 'https://plane.example.com', workspaceSlugs: ['alpha', 'beta'], apiKey: '' }, 'u-a')).toEqual({
      plane: { baseUrl: 'https://plane.example.com', workspaceSlug: 'alpha', workspaceSlugs: ['alpha', 'beta'] },
      expectUserId: 'u-a',
    });
    expect(planeSaveBody({ baseUrl: 'b', workspaceSlugs: [], apiKey: 'k' }, 'u-a').plane).toEqual({ baseUrl: 'b', workspaceSlug: '', workspaceSlugs: [], apiKey: 'k' });
  });
});

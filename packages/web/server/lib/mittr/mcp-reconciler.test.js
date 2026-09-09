import { describe, expect, it, vi } from 'vitest';
import { reconcileMcp } from './mcp-reconciler.js';

const fakeMcpApi = (existing = []) => ({
  listMcpConfigs: vi.fn(() => existing),
  createMcpConfig: vi.fn(),
  updateMcpConfig: vi.fn(),
  deleteMcpConfig: vi.fn(),
});

const enablementAllOn = { isEnabled: () => true };

const catalogWith = (items) => ({ mcp: { configured: true, items } });

const jira = { name: 'jira', config: { type: 'remote', url: 'https://jira.test/mcp' } };

describe('reconcileMcp', () => {
  it('creates an organisation entry that is not present yet', () => {
    const mcpApi = fakeMcpApi([]);
    const result = reconcileMcp({
      catalog: catalogWith([jira]),
      enablement: enablementAllOn,
      workingDirectory: '/repo',
      mcpApi,
    });
    expect(mcpApi.createMcpConfig).toHaveBeenCalledWith(
      'mittr/jira',
      { type: 'remote', url: 'https://jira.test/mcp' },
      '/repo',
      'user',
    );
    expect(result.created).toEqual(['mittr/jira']);
  });

  it('removes an organisation entry the catalog no longer lists', () => {
    const mcpApi = fakeMcpApi([{ name: 'mittr/retired' }, { name: 'mittr/jira' }]);
    reconcileMcp({
      catalog: catalogWith([jira]),
      enablement: enablementAllOn,
      workingDirectory: '/repo',
      mcpApi,
    });
    expect(mcpApi.deleteMcpConfig).toHaveBeenCalledWith('mittr/retired', '/repo');
    expect(mcpApi.deleteMcpConfig).toHaveBeenCalledTimes(1);
  });

  it('never touches an entry a developer added themselves', () => {
    const mcpApi = fakeMcpApi([{ name: 'my-own-thing' }]);
    reconcileMcp({
      catalog: catalogWith([]),
      enablement: enablementAllOn,
      workingDirectory: '/repo',
      mcpApi,
    });
    expect(mcpApi.deleteMcpConfig).not.toHaveBeenCalled();
  });

  it('does not install an entry the developer disabled', () => {
    const mcpApi = fakeMcpApi([]);
    reconcileMcp({
      catalog: catalogWith([jira]),
      enablement: { isEnabled: (kind, name) => !(kind === 'mcp' && name === 'jira') },
      workingDirectory: '/repo',
      mcpApi,
    });
    expect(mcpApi.createMcpConfig).not.toHaveBeenCalled();
  });

  it('removes an entry that is present but has since been disabled', () => {
    const mcpApi = fakeMcpApi([{ name: 'mittr/jira' }]);
    reconcileMcp({
      catalog: catalogWith([jira]),
      enablement: { isEnabled: () => false },
      workingDirectory: '/repo',
      mcpApi,
    });
    expect(mcpApi.deleteMcpConfig).toHaveBeenCalledWith('mittr/jira', '/repo');
  });

  it('does nothing at all when the catalog never configured mcp', () => {
    const mcpApi = fakeMcpApi([{ name: 'mittr/jira' }]);
    reconcileMcp({
      catalog: { mcp: { configured: false, items: [] } },
      enablement: enablementAllOn,
      workingDirectory: '/repo',
      mcpApi,
    });
    expect(mcpApi.deleteMcpConfig).not.toHaveBeenCalled();
    expect(mcpApi.createMcpConfig).not.toHaveBeenCalled();
  });
});

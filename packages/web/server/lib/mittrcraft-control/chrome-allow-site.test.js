import { describe, expect, it, vi } from 'vitest';

import { createMittrCraftControlService } from './service.js';
import { createChromeApprovals } from './chrome-approvals.js';
import { MITTRCRAFT_AGENT_TOOL_ACTIONS, MITTRCRAFT_CHROME_ACTIONS, MITTRCRAFT_VOICE_ACTIONS } from './actions.js';

const createService = () => {
  let stored = { agentChromeProfile: 'Default', agentChromeApprovedHosts: [] };
  const run = vi.fn(async (command) => {
    if (command[0] === 'get' && command[1] === 'url') return { url: 'https://example.com/' };
    if (command[0] === 'open') return { url: command[1], title: 'Page' };
    return {};
  });
  const persistSettings = vi.fn(async (changes) => { stored = { ...stored, ...changes }; });
  const chromeApprovals = createChromeApprovals({ readSettings: async () => stored, persistSettings });
  const service = createMittrCraftControlService({
    readSettingsFromDiskMigrated: vi.fn(async () => stored),
    sanitizeProjects: (projects) => projects,
    buildOpenCodeUrl: () => 'http://127.0.0.1:4096/',
    getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: vi.fn(),
    sessionService: {},
    scheduledTaskService: {},
    chromeControl: { available: true, chromeInstalled: () => true, run, profiles: vi.fn() },
    chromeApprovals,
  });
  return { service, run, persistSettings, stored: () => stored };
};

const voice = { sessionId: 'voice' };

describe('chrome.allow_site', () => {
  it('is a voice-only action, never offered to the coding agent or the Chrome tool', () => {
    expect(MITTRCRAFT_VOICE_ACTIONS).toContain('chrome.allow_site');
    expect(MITTRCRAFT_AGENT_TOOL_ACTIONS).not.toContain('chrome.allow_site');
    expect(MITTRCRAFT_CHROME_ACTIONS).not.toContain('chrome.allow_site');
  });

  it('allows the host for the calling conversation only and never persists it', async () => {
    const { service, persistSettings, stored } = createService();
    await expect(service.execute('chrome.open', { url: 'https://example.com/' }, '/repo', voice))
      .rejects.toMatchObject({ code: 'site_approval_required', host: 'example.com' });
    await expect(service.execute('chrome.allow_site', { host: 'Example.com' }, '/repo', voice))
      .resolves.toEqual({ allowed: true, host: 'example.com', scope: 'conversation' });
    await expect(service.execute('chrome.open', { url: 'https://example.com/' }, '/repo', voice))
      .resolves.toMatchObject({ url: 'https://example.com/' });
    expect(await service.isChromeHostAllowed('voice', 'example.com')).toBe(true);
    expect(await service.isChromeHostAllowed('ses_other', 'example.com')).toBe(false);
    expect(persistSettings).not.toHaveBeenCalled();
    expect(stored().agentChromeApprovedHosts).toEqual([]);
  });

  it('ends with the conversation', async () => {
    const { service } = createService();
    await service.execute('chrome.allow_site', { host: 'example.com' }, '/repo', voice);
    service.endChromeConversation('voice');
    expect(await service.isChromeHostAllowed('voice', 'example.com')).toBe(false);
    await expect(service.execute('chrome.open', { url: 'https://example.com/' }, '/repo', voice))
      .rejects.toMatchObject({ code: 'site_approval_required' });
  });

  it('is withdrawn when the person removes the site in settings', async () => {
    const { service } = createService();
    await service.execute('chrome.allow_site', { host: 'example.com' }, '/repo', voice);
    await service.removeChromeHost('example.com');
    expect(await service.isChromeHostAllowed('voice', 'example.com')).toBe(false);
  });

  it('needs a calling conversation and a plain host', async () => {
    const { service } = createService();
    await expect(service.execute('chrome.allow_site', { host: 'example.com' }, '/repo', {})).rejects.toMatchObject({ statusCode: 400 });
    for (const host of ['', 'https://example.com/', 'exa mple.com', 'example.com/path', 'a@b.com']) {
      await expect(service.execute('chrome.allow_site', { host }, '/repo', voice)).rejects.toMatchObject({ statusCode: 400 });
    }
  });
});

import { describe, expect, it, vi } from 'vitest';

import { createMittrCraftControlService } from './service.js';
import {
  MITTRCRAFT_AGENT_TOOL_ACTIONS,
  MITTRCRAFT_ALL_ACTIONS,
  MITTRCRAFT_VOICE_ACTIONS,
  MITTRCRAFT_WEB_ACTIONS,
} from './actions.js';

const assistant = (id, created, text) => ({
  info: { id, role: 'assistant', time: { created, completed: created + 1 } },
  parts: [{ type: 'text', text }],
});

const createService = ({ settings = {}, messages = [] } = {}) => {
  const client = {
    session: {
      list: vi.fn(async () => ({ data: [] })),
      status: vi.fn(async () => ({ data: {} })),
      messages: vi.fn(async () => ({ data: messages })),
      abort: vi.fn(async () => ({ data: true })),
    },
    experimental: { session: { list: vi.fn(async () => ({ data: [] })) } },
  };
  const service = createMittrCraftControlService({
    readSettingsFromDiskMigrated: vi.fn(async () => ({ projects: [], ...settings })),
    sanitizeProjects: (projects) => projects,
    buildOpenCodeUrl: () => 'http://127.0.0.1:4096/',
    getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: vi.fn(),
    createClient: vi.fn(() => client),
    sessionService: { create: vi.fn(), send: vi.fn(), fork: vi.fn() },
    scheduledTaskService: { status: vi.fn(), resolveProjectID: vi.fn(), list: vi.fn() },
  });
  return { service, client };
};

describe('voice-only session actions', () => {
  it('are allowed by the control contract but never offered to the coding agent or the web tool', () => {
    expect(MITTRCRAFT_VOICE_ACTIONS).toEqual(['session.stop', 'session.read_reply', 'chrome.allow_site']);
    for (const action of MITTRCRAFT_VOICE_ACTIONS) {
      expect(MITTRCRAFT_ALL_ACTIONS).toContain(action);
      expect(MITTRCRAFT_AGENT_TOOL_ACTIONS).not.toContain(action);
      expect(MITTRCRAFT_WEB_ACTIONS).not.toContain(action);
    }
  });

  it('session.stop aborts only the named session in its directory', async () => {
    const { service, client } = createService();
    await expect(service.execute('session.stop', { sessionId: 'ses_a', directory: '/repo' }))
      .resolves.toEqual({ stopped: true, sessionId: 'ses_a', directory: '/repo' });
    expect(client.session.abort).toHaveBeenCalledTimes(1);
    expect(client.session.abort).toHaveBeenCalledWith({ sessionID: 'ses_a', directory: '/repo' });
  });

  it('session.stop without a session id is a usage error and aborts nothing', async () => {
    const { service, client } = createService();
    await expect(service.execute('session.stop', { directory: '/repo' })).rejects.toThrow('sessionId is required');
    expect(client.session.abort).not.toHaveBeenCalled();
  });

  it('session.read_reply gives the newest assistant answer as speakable text', async () => {
    const { service } = createService({
      messages: [
        assistant('m1', 10, 'old answer'),
        assistant('m2', 20, '## Done\n\nFixed **two** bugs in `auth.ts`. See [the PR](https://example.com/pr/1).'),
      ],
    });
    const result = await service.execute('session.read_reply', { sessionId: 'ses_a', directory: '/repo' });
    expect(result.sessionId).toBe('ses_a');
    expect(result.truncated).toBe(false);
    expect(result.text).toContain('Fixed two bugs');
    expect(result.text).not.toMatch(/[#*`]|https?:\/\//);
    expect(result.text).not.toContain('old answer');
  });

  it('session.read_reply caps a long answer at the voiceReplyMaxChars setting and says so', async () => {
    const { service } = createService({
      settings: { voiceReplyMaxChars: 1000 },
      messages: [assistant('m1', 10, 'word '.repeat(1000))],
    });
    const result = await service.execute('session.read_reply', { sessionId: 'ses_a', directory: '/repo' });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(1000);
  });

  it('session.read_reply on a session with no answer yet says there is none', async () => {
    const { service } = createService({ messages: [] });
    await expect(service.execute('session.read_reply', { sessionId: 'ses_a', directory: '/repo' }))
      .resolves.toEqual({ sessionId: 'ses_a', directory: '/repo', text: null, truncated: false });
  });
});

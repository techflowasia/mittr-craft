import { describe, expect, it, vi } from 'vitest';

import {
  VOICE_CONTEXT_MAX_CHARS,
  createSessionLookup,
  createVoiceChromePage,
  createVoiceContextBuilder,
} from './context.js';

const SECRET = 'SECRET-BODY-TEXT';

const openCodeClient = ({ status = { type: 'busy' }, fail = {} } = {}) => ({
  experimental: {
    session: {
      list: vi.fn(async () => ({ data: [{ id: 'ses_1', title: 'Fix the login page', directory: '/repo/app' }] })),
    },
  },
  session: {
    get: vi.fn(async () => ({ data: { id: 'ses_1', title: 'Fix the login page', directory: '/repo/app' } })),
    status: vi.fn(async () => {
      if (fail.status) throw new Error('down');
      return { data: { ses_1: status } };
    }),
    todo: vi.fn(async () => {
      if (fail.todo) throw new Error('down');
      return {
        data: [
          { content: `${SECRET} one`, status: 'completed' },
          { content: `${SECRET} two`, status: 'in_progress' },
          { content: `${SECRET} three`, status: 'pending' },
          { content: `${SECRET} four`, status: 'cancelled' },
        ],
      };
    }),
    messages: vi.fn(async () => ({ data: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: SECRET }] }] })),
  },
  permission: {
    list: vi.fn(async () => ({ data: [{ id: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: [SECRET], metadata: { command: SECRET } }] })),
  },
});

const chromeControl = (page = { url: 'https://example.com/pricing', title: 'Pricing — Example', text: SECRET }) => ({
  available: true,
  run: vi.fn(async (command) => {
    if (command[1] === 'url') return { url: page.url, text: SECRET };
    if (command[1] === 'title') return { title: page.title, text: SECRET };
    return { text: SECRET };
  }),
});

const buildContext = async ({ client = openCodeClient(), chrome = chromeControl(), mounted = true, queuedPrompts = 2, opened = true } = {}) => {
  const lookup = createSessionLookup({ getClient: async () => client });
  const page = createVoiceChromePage({ chromeControl: chrome, readSettings: async () => ({ agentChromeProfile: 'Default' }) });
  if (opened) page.note('chrome.open', true);
  const build = createVoiceContextBuilder({
    listProjects: async () => [{ id: 'p1', path: '/repo/app', label: 'App' }],
    describeSession: lookup.describe,
    readChromePage: page.read,
    isBrowserMounted: () => mounted,
  });
  return build({ directory: '/repo/app', sessionId: 'ses_1', queuedPrompts });
};

describe('voice context', () => {
  it('describes where the person is from every source that is known', async () => {
    const context = await buildContext();
    expect(context).toContain('App');
    expect(context).toContain('/repo/app');
    expect(context).toContain('Fix the login page');
    expect(context).toContain('ses_1');
    expect(context).toContain('busy');
    expect(context).toContain('1 of 3');
    expect(context).toContain('permission request');
    expect(context).toContain('2 prompts queued');
    expect(context).toContain('Pricing — Example');
    expect(context).toContain('https://example.com/pricing');
    expect(context).toMatch(/in-app browser: open/i);
  });

  it('never carries message text, page text, todo text or permission details', async () => {
    const client = openCodeClient();
    const context = await buildContext({ client });
    expect(context).not.toContain(SECRET);
    expect(client.session.messages).not.toHaveBeenCalled();
  });

  it('says a lookup failed instead of reporting it as empty', async () => {
    const context = await buildContext({ client: openCodeClient({ fail: { status: true, todo: true } }) });
    expect(context).toContain('status unknown');
    expect(context).not.toContain('idle');
    expect(context).not.toContain('of 3');
  });

  it('reports no Chrome page without starting Chrome when this server never opened one', async () => {
    const chrome = chromeControl();
    const context = await buildContext({ chrome, opened: false, mounted: false });
    expect(chrome.run).not.toHaveBeenCalled();
    expect(context).toMatch(/chrome: no page open/i);
    expect(context).toMatch(/in-app browser: not open/i);
  });

  it('forgets the Chrome page once the voice closes it', async () => {
    const chrome = chromeControl();
    const page = createVoiceChromePage({ chromeControl: chrome, readSettings: async () => ({ agentChromeProfile: 'Default' }) });
    page.note('chrome.open', true);
    page.note('chrome.close', true);
    expect(await page.read()).toBeNull();
    expect(chrome.run).not.toHaveBeenCalled();
  });

  it('stays within the platform limit', async () => {
    const client = openCodeClient();
    client.experimental.session.list = vi.fn(async () => ({ data: [{ id: 'ses_1', title: 'x'.repeat(20000), directory: '/repo/app' }] }));
    const context = await buildContext({ client });
    expect(context.length).toBeLessThanOrEqual(VOICE_CONTEXT_MAX_CHARS);
  });

  it('works with no project, no session and no Chrome', async () => {
    const build = createVoiceContextBuilder({
      listProjects: async () => [],
      describeSession: vi.fn(),
      readChromePage: async () => null,
      isBrowserMounted: () => false,
    });
    const context = await build({});
    expect(context).toMatch(/no project/i);
    expect(context).toMatch(/no session/i);
  });
});

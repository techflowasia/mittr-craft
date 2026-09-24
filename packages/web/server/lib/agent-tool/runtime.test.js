import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentToolRuntime } from './runtime.js';
import { MITTRCRAFT_AGENT_TOOL_ACTION_DEFINITIONS, MITTRCRAFT_CONTROL_ACTION_DEFINITIONS } from '../mittrcraft-control/actions.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const createRuntime = async (overrides = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mittrcraft-agent-tool-'));
  temporaryDirectories.push(dataDir);
  const executeAction = vi.fn(async () => ({ projects: [] }));
  const env = {};
  const runtime = createAgentToolRuntime({
    crypto,
    fsPromises: fs,
    path,
    dataDir,
    getActivePort: () => 3901,
    executeAction,
    env,
    ...overrides,
  });
  return { runtime, dataDir, executeAction, env };
};

describe('agent tool action allowlist', () => {
  it('defines a short title and agent description for every action', () => {
    expect(MITTRCRAFT_CONTROL_ACTION_DEFINITIONS.every(({ action, title, description }) => action && title && description)).toBe(true);
  });

  it.each([
    'projects.list',
    'models.list',
    'session.list',
    'session.create',
    'session.send',
    'session.fork',
    'session.status',
    'session.messages',
    'schedule.list',
    'schedule.create',
    'schedule.run',
    'schedule.delete',
    'schedule.toggle',
  ])('delegates %s to the shared control service', async (action) => {
    const { runtime, executeAction } = await createRuntime();
    const input = { action, projectId: 'project-1' };
    await runtime.execute({ input, contextDirectory: '/work/project' });
    expect(executeAction).toHaveBeenCalledWith(action, input, '/work/project', {});
  });

  it.each([
    'session.delete',
    'schedule.status',
  ])('rejects %s outside the agent allowlist without invoking the service', async (action) => {
    const { runtime, executeAction } = await createRuntime();
    await expect(runtime.execute({ input: { action } })).resolves.toEqual(expect.objectContaining({
      ok: false,
      action,
      error: expect.objectContaining({ kind: 'usage' }),
    }));
    expect(executeAction).not.toHaveBeenCalled();
  });
});

describe('managed agent tool runtime', () => {
  it('materializes the plugin and preserves configured plugin entries', async () => {
    const { runtime, dataDir, env } = await createRuntime();
    env.OPENCODE_CONFIG_CONTENT = '{ // existing\n "plugin": ["file:///existing.js", ["example-plugin", {"flag": true}]], "model": "test/model" }';

    const preparedEnv = await runtime.prepareManagedOpenCodeEnv();
    const config = JSON.parse(preparedEnv.OPENCODE_CONFIG_CONTENT);
    const pluginPath = path.join(dataDir, 'agent-tool', 'mittrcraft-plugin.js');
    const source = await fs.readFile(pluginPath, 'utf8');

    expect(config.model).toBe('test/model');
    expect(config.plugin).toEqual([
      'file:///existing.js',
      ['example-plugin', { flag: true }],
      expect.stringContaining('/agent-tool/mittrcraft-plugin.js'),
    ]);
    expect(preparedEnv.MITTRCRAFT_AGENT_TOOL_URL).toBe('http://127.0.0.1:3901/api/mittrcraft/agent-tool');
    expect(preparedEnv.MITTRCRAFT_AGENT_TOOL_TOKEN).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(source).toContain('mittrcraft: {');
    for (const { action, description } of MITTRCRAFT_AGENT_TOOL_ACTION_DEFINITIONS) {
      expect(source).toContain(JSON.stringify({ const: action, description }));
    }
    expect(source).not.toContain('"schedule.status"');
    const pluginModule = await import(`${pathToFileURL(pluginPath).href}?schema=${Date.now()}`);
    const hooks = await pluginModule.MittrCraftPlugin();
    expect(hooks.tool.mittrcraft.description).toContain('Session dispatches return immediately by default');
    expect(hooks.tool.mittrcraft.description).toContain('Set wait only when the user asks or the next step requires the completed result');
    expect(hooks.tool.mittrcraft.args.action.oneOf).toContainEqual({
      const: 'session.messages',
      description: 'Read text-only messages and current sessionStatus for sessionId; directory and limit 10 are defaults',
    });
    expect(hooks.tool.mittrcraft.args.parameters.properties.wait.description).toBe(
      'Wait for current session activity to become idle. Omit by default; use only when the user asks or the next step requires the completed result',
    );
    expect(hooks.tool.mittrcraft.args.parameters.properties.sessionId).toEqual({ type: 'string' });
    expect(source).not.toContain('title: "MittrCraft"');
    expect(source).not.toContain('@opencode-ai/plugin');
    expect(source).not.toContain(preparedEnv.MITTRCRAFT_AGENT_TOOL_TOKEN);
  });

  it('emits both tools, each carrying only its own actions and inputs', async () => {
    const { runtime, dataDir } = await createRuntime();
    await runtime.prepareManagedOpenCodeEnv();
    const pluginPath = path.join(dataDir, 'agent-tool', 'mittrcraft-plugin.js');
    const pluginModule = await import(`${pathToFileURL(pluginPath).href}?both=${Date.now()}`);
    const { tool } = await pluginModule.MittrCraftPlugin();

    const controlActions = tool.mittrcraft.args.action.enum;
    const webActions = tool.mittrcraft_web.args.action.enum;
    expect(webActions).toContain('browser.open');
    expect(controlActions).not.toContain('browser.open');
    expect(webActions).not.toContain('session.create');

    // Turning one tool off has to remove its inputs too, not just its actions.
    expect(Object.keys(tool.mittrcraft_web.args.parameters.properties)).toContain('url');
    expect(Object.keys(tool.mittrcraft.args.parameters.properties)).not.toContain('url');
    expect(Object.keys(tool.mittrcraft.args.parameters.properties)).toContain('sessionId');
  });

  it('accepts inputs passed beside the action, not only inside parameters', async () => {
    const { runtime, dataDir } = await createRuntime();
    const prepared = await runtime.prepareManagedOpenCodeEnv();
    const pluginPath = path.join(dataDir, 'agent-tool', 'mittrcraft-plugin.js');
    const pluginModule = await import(`${pathToFileURL(pluginPath).href}?flat=${Date.now()}`);
    const { tool } = await pluginModule.MittrCraftPlugin();

    const sent = [];
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.MITTRCRAFT_AGENT_TOOL_URL;
    const originalToken = process.env.MITTRCRAFT_AGENT_TOOL_TOKEN;
    process.env.MITTRCRAFT_AGENT_TOOL_URL = prepared.MITTRCRAFT_AGENT_TOOL_URL;
    process.env.MITTRCRAFT_AGENT_TOOL_TOKEN = prepared.MITTRCRAFT_AGENT_TOOL_TOKEN;
    globalThis.fetch = async (_endpoint, init) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ schemaVersion: 1, ok: true, action: 'browser.open', data: {} }));
    };
    const context = { directory: '/work/project', abort: new AbortController().signal, metadata: () => {} };

    try {
      // The shape a model actually produced: url and viewport next to action.
      await tool.mittrcraft_web.execute(
        { action: 'browser.open', url: 'https://example.test', viewport: 'mobile' },
        context,
      );
      // The documented shape must keep working, and win when both are present.
      await tool.mittrcraft_web.execute(
        { action: 'browser.open', url: 'https://ignored.test', parameters: { url: 'https://example.test/nested' } },
        context,
      );
      // Both tools come from one template, so session control accepts it too.
      await tool.mittrcraft.execute(
        { action: 'session.messages', sessionId: 'ses_1', limit: 3 },
        context,
      );
    } finally {
      globalThis.fetch = originalFetch;
      process.env.MITTRCRAFT_AGENT_TOOL_URL = originalUrl;
      process.env.MITTRCRAFT_AGENT_TOOL_TOKEN = originalToken;
    }

    expect(sent[0].input).toEqual({ action: 'browser.open', url: 'https://example.test', viewport: 'mobile' });
    expect(sent[1].input.url).toBe('https://example.test/nested');
    expect(sent[2].input).toEqual({ action: 'session.messages', sessionId: 'ses_1', limit: 3 });
  });

  it('omits a tool the user turned off', async () => {
    const { runtime, dataDir } = await createRuntime();
    await runtime.prepareManagedOpenCodeEnv({ includeControl: false, includeWeb: true });
    const pluginPath = path.join(dataDir, 'agent-tool', 'mittrcraft-plugin.js');
    const pluginModule = await import(`${pathToFileURL(pluginPath).href}?web=${Date.now()}`);
    const { tool } = await pluginModule.MittrCraftPlugin();

    expect(Object.keys(tool)).toEqual(['mittrcraft_web']);
  });

  it('refuses to inject a plugin with no tools in it', async () => {
    const { runtime } = await createRuntime();
    let failed = false;
    try {
      await runtime.prepareManagedOpenCodeEnv({ includeControl: false, includeWeb: false });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  it('executes actions through the shared control service', async () => {
    const executeAction = vi.fn(async () => ({ projects: [] }));
    const { runtime } = await createRuntime({ executeAction });
    const result = await runtime.execute({
      input: { action: 'projects.list' },
      contextDirectory: '/work/project',
    });

    expect(result).toEqual({
      schemaVersion: 1,
      ok: true,
      action: 'projects.list',
      data: { projects: [] },
    });
    expect(executeAction).toHaveBeenCalledWith('projects.list', { action: 'projects.list' }, '/work/project', {});
  });

  it('keeps service failures as structured tool results', async () => {
    const error = Object.assign(new Error('Task not found'), { statusCode: 404 });
    const { runtime } = await createRuntime({ executeAction: vi.fn(async () => { throw error; }) });

    await expect(runtime.execute({
      input: { action: 'schedule.run', taskId: 'missing' },
      contextDirectory: '/work/project',
    })).resolves.toEqual(expect.objectContaining({
      schemaVersion: 1,
      ok: false,
      action: 'schedule.run',
      error: { message: 'Task not found', kind: 'usage' },
    }));
  });

  it('forwards cancellation to the shared control service', async () => {
    const executeAction = vi.fn(async (_action, _input, _directory, options) => {
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('MittrCraft action was cancelled'), { statusCode: 499 })), { once: true });
      });
    });
    const { runtime } = await createRuntime({ executeAction });
    const controller = new AbortController();
    const pending = runtime.execute({ input: { action: 'projects.list' } }, { signal: controller.signal });

    controller.abort();

    await expect(pending).resolves.toEqual(expect.objectContaining({
      ok: false,
      action: 'projects.list',
      error: { message: 'MittrCraft action was cancelled', kind: 'runtime' },
    }));
    expect(executeAction).toHaveBeenCalledWith('projects.list', { action: 'projects.list' }, undefined, { signal: controller.signal });
  });

  it('requires the per-child token on the loopback route', async () => {
    const { runtime } = await createRuntime();
    const env = await runtime.prepareManagedOpenCodeEnv();
    const app = express();
    runtime.registerRoutes(app, express);

    await request(app)
      .post('/api/mittrcraft/agent-tool')
      .send({ input: { action: 'projects.list' } })
      .expect(401);

    const response = await request(app)
      .post('/api/mittrcraft/agent-tool')
      .set('authorization', `Bearer ${env.MITTRCRAFT_AGENT_TOOL_TOKEN}`)
      .send({ input: { action: 'projects.list' } })
      .expect(200);
    expect(response.body).toEqual(expect.objectContaining({ ok: true, action: 'projects.list' }));
  });

  it('executes through the materialized plugin and authenticated callback', async () => {
    let activePort = null;
    const { runtime, dataDir } = await createRuntime({ getActivePort: () => activePort });
    const app = express();
    runtime.registerRoutes(app, express);
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    activePort = server.address().port;

    const previousUrl = process.env.MITTRCRAFT_AGENT_TOOL_URL;
    const previousToken = process.env.MITTRCRAFT_AGENT_TOOL_TOKEN;
    try {
      const env = await runtime.prepareManagedOpenCodeEnv();
      process.env.MITTRCRAFT_AGENT_TOOL_URL = env.MITTRCRAFT_AGENT_TOOL_URL;
      process.env.MITTRCRAFT_AGENT_TOOL_TOKEN = env.MITTRCRAFT_AGENT_TOOL_TOKEN;
      const pluginPath = path.join(dataDir, 'agent-tool', 'mittrcraft-plugin.js');
      const pluginModule = await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`);
      const hooks = await pluginModule.MittrCraftPlugin();
      const metadata = vi.fn();

      const result = await hooks.tool.mittrcraft.execute(
        { action: 'projects.list', parameters: {} },
        { directory: '/work/project', abort: new AbortController().signal, metadata },
      );

      expect(JSON.parse(result.output)).toEqual({
        schemaVersion: 1,
        ok: true,
        action: 'projects.list',
        data: { projects: [] },
      });
      expect(result.title).toBe('List configured projects');
      expect(result.metadata.mittrcraft.description).toBe('List configured projects');
      expect(metadata).toHaveBeenCalledWith(expect.objectContaining({
        title: 'List configured projects',
        metadata: expect.objectContaining({
          mittrcraft: expect.objectContaining({ description: 'List configured projects' }),
        }),
      }));
    } finally {
      if (previousUrl === undefined) delete process.env.MITTRCRAFT_AGENT_TOOL_URL;
      else process.env.MITTRCRAFT_AGENT_TOOL_URL = previousUrl;
      if (previousToken === undefined) delete process.env.MITTRCRAFT_AGENT_TOOL_TOKEN;
      else process.env.MITTRCRAFT_AGENT_TOOL_TOKEN = previousToken;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('lifts a screenshot result into an attachment instead of inlining it in output', async () => {
    const { runtime, dataDir } = await createRuntime();
    const prepared = await runtime.prepareManagedOpenCodeEnv({ includeComputer: true });
    const pluginPath = path.join(dataDir, 'agent-tool', 'mittrcraft-plugin.js');
    const pluginModule = await import(`${pathToFileURL(pluginPath).href}?screenshot=${Date.now()}`);
    const { tool } = await pluginModule.MittrCraftPlugin();

    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.MITTRCRAFT_AGENT_TOOL_URL;
    const originalToken = process.env.MITTRCRAFT_AGENT_TOOL_TOKEN;
    process.env.MITTRCRAFT_AGENT_TOOL_URL = prepared.MITTRCRAFT_AGENT_TOOL_URL;
    process.env.MITTRCRAFT_AGENT_TOOL_TOKEN = prepared.MITTRCRAFT_AGENT_TOOL_TOKEN;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        schemaVersion: 1,
        ok: true,
        action: 'computer.screenshot',
        data: {
          path: '.mittrcraft/screenshots/desktop-1.png',
          hint: 'The image is attached for you to view directly; write ![](...) in your reply to also show it to the user.',
          width: 1920,
          height: 1080,
          imageBase64: 'ZmFrZS1wbmctYnl0ZXM=',
          imageMime: 'image/png',
        },
      }));
    const context = { directory: '/work/project', abort: new AbortController().signal, metadata: () => {} };

    let result;
    try {
      result = await tool.mittrcraft_computer.execute({ action: 'computer.screenshot', parameters: {} }, context);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.MITTRCRAFT_AGENT_TOOL_URL = originalUrl;
      process.env.MITTRCRAFT_AGENT_TOOL_TOKEN = originalToken;
    }

    expect(result.attachments).toEqual([
      { type: 'file', mime: 'image/png', url: 'data:image/png;base64,ZmFrZS1wbmctYnl0ZXM=', filename: 'screenshot.png' },
    ]);
    const parsedOutput = JSON.parse(result.output);
    expect(parsedOutput.data.path).toBe('.mittrcraft/screenshots/desktop-1.png');
    expect(parsedOutput.data.imageBase64).toBeUndefined();
    expect(result.output).not.toContain('ZmFrZS1wbmctYnl0ZXM=');
  });

  it('leaves output untouched for actions with no image data', async () => {
    const { runtime, dataDir } = await createRuntime();
    const prepared = await runtime.prepareManagedOpenCodeEnv({ includeComputer: true });
    const pluginPath = path.join(dataDir, 'agent-tool', 'mittrcraft-plugin.js');
    const pluginModule = await import(`${pathToFileURL(pluginPath).href}?noimage=${Date.now()}`);
    const { tool } = await pluginModule.MittrCraftPlugin();

    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.MITTRCRAFT_AGENT_TOOL_URL;
    const originalToken = process.env.MITTRCRAFT_AGENT_TOOL_TOKEN;
    process.env.MITTRCRAFT_AGENT_TOOL_URL = prepared.MITTRCRAFT_AGENT_TOOL_URL;
    process.env.MITTRCRAFT_AGENT_TOOL_TOKEN = prepared.MITTRCRAFT_AGENT_TOOL_TOKEN;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ schemaVersion: 1, ok: true, action: 'computer.list_apps', data: { apps: [] } }));
    const context = { directory: '/work/project', abort: new AbortController().signal, metadata: () => {} };

    let result;
    try {
      result = await tool.mittrcraft_computer.execute({ action: 'computer.list_apps', parameters: {} }, context);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.MITTRCRAFT_AGENT_TOOL_URL = originalUrl;
      process.env.MITTRCRAFT_AGENT_TOOL_TOKEN = originalToken;
    }

    expect(result.attachments).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual({ schemaVersion: 1, ok: true, action: 'computer.list_apps', data: { apps: [] } });
  });
});

describe('mittrcraft_chrome tool', () => {
  const loadPlugin = async (runtime, dataDir, options) => {
    const prepared = await runtime.prepareManagedOpenCodeEnv(options);
    const pluginPath = path.join(dataDir, 'agent-tool', 'mittrcraft-plugin.js');
    const pluginModule = await import(`${pathToFileURL(pluginPath).href}?chrome=${Date.now()}-${Math.random()}`);
    return { prepared, hooks: await pluginModule.MittrCraftPlugin() };
  };

  const withEnv = async (prepared, fn) => {
    const originalUrl = process.env.MITTRCRAFT_AGENT_TOOL_URL;
    const originalToken = process.env.MITTRCRAFT_AGENT_TOOL_TOKEN;
    const originalFetch = globalThis.fetch;
    process.env.MITTRCRAFT_AGENT_TOOL_URL = prepared.MITTRCRAFT_AGENT_TOOL_URL;
    process.env.MITTRCRAFT_AGENT_TOOL_TOKEN = prepared.MITTRCRAFT_AGENT_TOOL_TOKEN;
    try {
      return await fn();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.MITTRCRAFT_AGENT_TOOL_URL;
      else process.env.MITTRCRAFT_AGENT_TOOL_URL = originalUrl;
      if (originalToken === undefined) delete process.env.MITTRCRAFT_AGENT_TOOL_TOKEN;
      else process.env.MITTRCRAFT_AGENT_TOOL_TOKEN = originalToken;
    }
  };

  const context = (ask) => ({ sessionID: 'ses_1', directory: '/work', abort: new AbortController().signal, metadata: () => {}, ask });

  it('is emitted only when enabled', async () => {
    const { runtime, dataDir } = await createRuntime();
    const { hooks } = await loadPlugin(runtime, dataDir, { includeChrome: true });
    expect(hooks.tool.mittrcraft_chrome).toBeDefined();
    const { hooks: without } = await loadPlugin(runtime, dataDir, { includeChrome: false });
    expect(without.tool.mittrcraft_chrome).toBeUndefined();
  });

  it('asks the user once for an unapproved host and retries saying the question was answered', async () => {
    const { runtime, dataDir } = await createRuntime();
    const { prepared, hooks } = await loadPlugin(runtime, dataDir, { includeChrome: true });
    const bodies = [];
    const ask = vi.fn(async () => {});
    await withEnv(prepared, async () => {
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        if (!body.approvalAnswered) {
          return new Response(JSON.stringify({ schemaVersion: 1, ok: false, action: 'chrome.open', error: { message: 'not allowed yet', kind: 'usage', code: 'site_approval_required', host: 'github.com' } }));
        }
        return new Response(JSON.stringify({ schemaVersion: 1, ok: true, action: 'chrome.open', data: { url: 'https://github.com/' } }));
      };
      const result = await hooks.tool.mittrcraft_chrome.execute({ action: 'chrome.open', parameters: { url: 'https://github.com/' } }, context(ask));
      expect(JSON.parse(result.output).ok).toBe(true);
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ permission: 'mittrcraft_chrome', patterns: ['github.com'], always: ['github.com'] }));
    expect(bodies.map((body) => body.approvalAnswered ?? null)).toEqual([null, true]);
    expect(bodies.every((body) => body.approveHost === undefined)).toBe(true);
    expect(bodies[0].contextSessionId).toBe('ses_1');
  });

  it('reports a refusal and does not retry when the user denies', async () => {
    const { runtime, dataDir } = await createRuntime();
    const { prepared, hooks } = await loadPlugin(runtime, dataDir, { includeChrome: true });
    let calls = 0;
    await withEnv(prepared, async () => {
      globalThis.fetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({ schemaVersion: 1, ok: false, action: 'chrome.open', error: { message: 'x', kind: 'usage', code: 'site_approval_required', host: 'github.com' } }));
      };
      const result = await hooks.tool.mittrcraft_chrome.execute({ action: 'chrome.open', parameters: { url: 'https://github.com/' } }, context(async () => { throw new Error('rejected'); }));
      expect(JSON.parse(result.output).error.message).toMatch(/did not allow.*github\.com/);
    });
    expect(calls).toBe(1);
  });

  it('never lets the model approve a host through its own parameters', async () => {
    const { runtime, executeAction } = await createRuntime();
    await runtime.execute({ input: { action: 'chrome.open', url: 'https://x.example/', approveHost: 'x.example', approvalAnswered: true }, contextDirectory: '/w', contextSessionId: 'ses_1', approveHost: 'x.example' });
    expect(executeAction).toHaveBeenCalledWith('chrome.open', expect.anything(), '/w', { sessionId: 'ses_1' });
  });

  it('passes the plugin\'s approvalAnswered flag and session through to the service', async () => {
    const { runtime, executeAction } = await createRuntime();
    await runtime.execute({ input: { action: 'chrome.read' }, contextDirectory: '/w', contextSessionId: 'ses_1', approvalAnswered: true });
    expect(executeAction).toHaveBeenCalledWith('chrome.read', { action: 'chrome.read' }, '/w', { sessionId: 'ses_1', approvalAnswered: true });
  });

  it('carries the approval code and host in the result error', async () => {
    const error = Object.assign(new Error('nope'), { statusCode: 403, code: 'site_approval_required', host: 'github.com' });
    const { runtime } = await createRuntime({ executeAction: vi.fn(async () => { throw error; }) });
    const result = await runtime.execute({ input: { action: 'chrome.open' }, contextSessionId: 'ses_1' });
    expect(result.error).toMatchObject({ code: 'site_approval_required', host: 'github.com' });
  });

  it('closes the session\'s Chrome when OpenCode deletes the session', async () => {
    const { runtime, dataDir } = await createRuntime();
    const { prepared, hooks } = await loadPlugin(runtime, dataDir, { includeChrome: true });
    const bodies = [];
    await withEnv(prepared, async () => {
      globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response('{}'); };
      await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'ses_9' } } } });
    });
    expect(bodies).toEqual([{ input: { action: 'chrome.close' }, contextSessionId: 'ses_9' }]);
  });
});

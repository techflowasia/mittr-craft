import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagedConfigRuntime, MANAGED_CONFIG_FILE_NAME } from './managed-config-file.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const createHarness = async ({ settings = {}, env = {}, memoryAvailable = true, contributeConfig } = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-managed-config-'));
  temporaryDirectories.push(dataDir);
  const agentToolRuntime = {
    pluginDirectory: path.join(dataDir, 'agent-tool', 'openchamber-agent-tool'),
    materializePlugin: vi.fn(async (flags) => {
      await fs.mkdir(agentToolRuntime.pluginDirectory, { recursive: true });
      await fs.writeFile(path.join(agentToolRuntime.pluginDirectory, 'flags.json'), JSON.stringify(flags));
      return agentToolRuntime.pluginDirectory;
    }),
    createChildEnv: vi.fn(() => ({
      OPENCHAMBER_AGENT_TOOL_URL: 'http://127.0.0.1:3901/api/openchamber/agent-tool',
      OPENCHAMBER_AGENT_TOOL_TOKEN: 'token',
    })),
  };
  const current = { settings };
  const runtime = createManagedConfigRuntime({
    fsPromises: fs,
    path,
    dataDir,
    env,
    agentToolRuntime,
    readSettings: () => current.settings,
    isAgentMemoryAvailable: () => memoryAvailable,
    contributeConfig,
  });
  const readConfigFile = async () => JSON.parse(await fs.readFile(path.join(dataDir, MANAGED_CONFIG_FILE_NAME), 'utf8'));
  return { dataDir, runtime, agentToolRuntime, current, readConfigFile };
};

describe('managed OpenCode config file', () => {
  it('points the child at a config file listing the enabled plugins', async () => {
    const { dataDir, runtime, readConfigFile } = await createHarness({
      settings: {},
    });

    const childEnv = await runtime.buildManagedChildEnv();

    expect(childEnv.OPENCODE_CONFIG).toBe(path.join(dataDir, MANAGED_CONFIG_FILE_NAME));
    expect(childEnv.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(childEnv.OPENCHAMBER_AGENT_TOOL_TOKEN).toBe('token');
    expect(await readConfigFile()).toEqual({
      plugins: ['-opencode.browser', path.join(dataDir, 'agent-tool', 'openchamber-agent-tool')],
    });
  });

  it('materializes every listed plugin directory before naming it', async () => {
    const { runtime, readConfigFile } = await createHarness({ settings: {} });

    await runtime.buildManagedChildEnv();

    for (const directory of (await readConfigFile()).plugins.filter((entry) => !entry.startsWith('-'))) {
      expect((await fs.stat(directory)).isDirectory()).toBe(true);
    }
  });

  it('keeps the callback token in the child env while every tool is off', async () => {
    const { runtime, agentToolRuntime, readConfigFile } = await createHarness({
      settings: { agentControlToolEnabled: false, agentWebToolEnabled: false, agentMemoryToolEnabled: false },
    });

    const childEnv = await runtime.buildManagedChildEnv();

    expect(agentToolRuntime.materializePlugin).not.toHaveBeenCalled();
    expect(await readConfigFile()).toEqual({ plugins: ['-opencode.browser'] });
    // A tool switched on later reaches a process that can already call back.
    expect(childEnv.OPENCHAMBER_AGENT_TOOL_TOKEN).toBe('token');
  });

  it('rewrites the file when a tool is turned off, without a new token', async () => {
    const { dataDir, runtime, current, agentToolRuntime, readConfigFile } = await createHarness({
      settings: {},
    });
    await runtime.buildManagedChildEnv();

    current.settings = { agentControlToolEnabled: false, agentWebToolEnabled: false };
    expect(await runtime.refreshManagedConfigFile()).toEqual({ updated: true });

    const { plugins } = await readConfigFile();
    expect(plugins).toEqual(['-opencode.browser']);
    expect(agentToolRuntime.createChildEnv).toHaveBeenCalledTimes(1);
  });

  it('turns a tool back on without a restart', async () => {
    const { runtime, current, agentToolRuntime, readConfigFile } = await createHarness({
      settings: { agentControlToolEnabled: false, agentWebToolEnabled: false },
    });
    await runtime.buildManagedChildEnv();

    current.settings = { agentControlToolEnabled: false, agentWebToolEnabled: true };
    await runtime.refreshManagedConfigFile();

    expect((await readConfigFile()).plugins).toHaveLength(2);
    expect(agentToolRuntime.materializePlugin).toHaveBeenCalledWith({
      includeControl: false,
      includeWeb: true,
      includeMemory: false,
      includeNotify: false,
      codeMode: false,
    });
  });

  it('injects the notify tool only when it is switched on', async () => {
    const { runtime, agentToolRuntime } = await createHarness({
      settings: { agentControlToolEnabled: false, agentWebToolEnabled: false, agentNotifyToolEnabled: true },
    });

    await runtime.buildManagedChildEnv();

    expect(agentToolRuntime.materializePlugin).toHaveBeenCalledWith({
      includeControl: false,
      includeWeb: false,
      includeMemory: false,
      includeNotify: true,
      codeMode: false,
    });
  });

  it('puts the tools behind Code Mode only when the user asks for it', async () => {
    const { runtime, agentToolRuntime } = await createHarness({
      settings: { agentToolsCodeMode: true },
    });

    await runtime.buildManagedChildEnv();

    expect(agentToolRuntime.materializePlugin).toHaveBeenCalledWith({
      includeControl: true,
      includeWeb: true,
      includeMemory: false,
      includeNotify: false,
      codeMode: true,
    });
  });

  it('leaves a config file the user owns alone and keeps the restart requirement', async () => {
    const { dataDir, runtime } = await createHarness({
      settings: {},
      env: { OPENCODE_CONFIG: '/home/user/opencode.json', OPENCODE_CONFIG_CONTENT: '{"model":"test/model"}' },
    });

    const childEnv = await runtime.buildManagedChildEnv();

    expect(childEnv.OPENCODE_CONFIG).toBeUndefined();
    expect(JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT)).toEqual({
      model: 'test/model',
      plugins: ['-opencode.browser', path.join(dataDir, 'agent-tool', 'openchamber-agent-tool')],
    });
    await expect(fs.stat(path.join(dataDir, MANAGED_CONFIG_FILE_NAME))).rejects.toThrow();
    expect(await runtime.refreshManagedConfigFile()).toEqual({ updated: false, reason: 'external-config' });
  });

  it('contributions are written beside upstream plugins', async () => {
    const { dataDir, runtime, readConfigFile } = await createHarness({
      contributeConfig: async () => ({ providers: { x: { name: 'X' } }, plugins: ['/mine'] }),
    });

    await runtime.buildManagedChildEnv();

    expect(await readConfigFile()).toEqual({
      providers: { x: { name: 'X' } },
      plugins: ['-opencode.browser', path.join(dataDir, 'agent-tool', 'openchamber-agent-tool'), '/mine'],
    });
  });

  it('a refresh writes the contributions as they are now', async () => {
    const current = { config: { providers: { x: { name: 'X' } } } };
    const { runtime, readConfigFile } = await createHarness({ contributeConfig: () => current.config });
    await runtime.buildManagedChildEnv();

    current.config = { providers: { x: { name: 'X' } }, experimental: { policies: [] } };
    expect(await runtime.refreshManagedConfigFile()).toEqual({ updated: true });

    expect((await readConfigFile()).experimental).toEqual({ policies: [] });
  });

  it('no contributor writes the upstream file byte-identically', async () => {
    const { dataDir, runtime } = await createHarness();

    await runtime.buildManagedChildEnv();

    const pluginDirectory = path.join(dataDir, 'agent-tool', 'openchamber-agent-tool');
    expect(await fs.readFile(path.join(dataDir, MANAGED_CONFIG_FILE_NAME), 'utf8'))
      .toBe(`${JSON.stringify({ plugins: ['-opencode.browser', pluginDirectory] }, null, 2)}\n`);
  });

  it('a contributor that fails stops the engine start instead of dropping its config', async () => {
    const { runtime } = await createHarness({
      contributeConfig: async () => { throw new Error('contribution unavailable'); },
    });

    await expect(runtime.buildManagedChildEnv()).rejects.toThrow('contribution unavailable');
  });

  // OpenCode reads policies from its config layers lowest first and lets the
  // last match decide, so OPENCODE_CONFIG_CONTENT is the weakest place for a
  // policy and the user's own OPENCODE_CONFIG file outranks it.
  it('a contributor takes OPENCODE_CONFIG from the user and moves their config into OPENCODE_CONFIG_CONTENT', async () => {
    const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-user-config-'));
    temporaryDirectories.push(userDir);
    const userFile = path.join(userDir, 'opencode.jsonc');
    const userText = '{\n  // theirs\n  "model": "file/model",\n  "plugins": ["/theirs"],\n  "experimental": { "policies": [{ "action": "provider.use", "resource": "*", "effect": "allow" }] },\n}\n';
    await fs.writeFile(userFile, userText);
    const { dataDir, runtime, readConfigFile } = await createHarness({
      env: {
        OPENCODE_CONFIG: userFile,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          model: 'content/model',
          experimental: { policies: [{ action: 'provider.use', resource: 'other', effect: 'allow' }] },
        }),
      },
      contributeConfig: async () => ({
        providers: { x: { name: 'X' } },
        plugins: ['/mine'],
        experimental: { policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }] },
      }),
    });

    const childEnv = await runtime.buildManagedChildEnv();

    expect(childEnv.OPENCODE_CONFIG).toBe(path.join(dataDir, MANAGED_CONFIG_FILE_NAME));
    expect(await readConfigFile()).toEqual({
      providers: { x: { name: 'X' } },
      plugins: ['-opencode.browser', path.join(dataDir, 'agent-tool', 'openchamber-agent-tool'), '/mine'],
      experimental: { policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }] },
    });
    expect(JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT)).toEqual({
      model: 'content/model',
      plugins: ['/theirs'],
      experimental: {
        policies: [
          { action: 'provider.use', resource: '*', effect: 'allow' },
          { action: 'provider.use', resource: 'other', effect: 'allow' },
        ],
      },
    });
    expect(await fs.readFile(userFile, 'utf8')).toBe(userText);
    expect(await runtime.refreshManagedConfigFile()).toEqual({ updated: true });
  });

  it('a missing user OPENCODE_CONFIG file counts as empty once a contributor takes the layer', async () => {
    const { runtime } = await createHarness({
      env: { OPENCODE_CONFIG: path.join(os.tmpdir(), 'openchamber-no-such-config', 'opencode.json') },
      contributeConfig: async () => ({ providers: { x: { name: 'X' } } }),
    });

    expect(JSON.parse((await runtime.buildManagedChildEnv()).OPENCODE_CONFIG_CONTENT)).toEqual({});
  });

  it('an unreadable user OPENCODE_CONFIG file stops the start once a contributor takes the layer', async () => {
    const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-user-config-'));
    temporaryDirectories.push(userDir);
    const userFile = path.join(userDir, 'opencode.json');
    await fs.writeFile(userFile, '{ "model": ');
    const { runtime } = await createHarness({
      env: { OPENCODE_CONFIG: userFile },
      contributeConfig: async () => ({ providers: { x: { name: 'X' } } }),
    });

    await expect(runtime.buildManagedChildEnv()).rejects.toThrow(userFile);
  });

  it('leaves no temp file behind and never publishes a partial list', async () => {
    const { dataDir, runtime } = await createHarness({ settings: {} });

    await runtime.buildManagedChildEnv();
    await runtime.refreshManagedConfigFile();

    const entries = await fs.readdir(dataDir);
    expect(entries.filter((entry) => entry.includes('.tmp-'))).toEqual([]);
    expect(entries).toContain(MANAGED_CONFIG_FILE_NAME);
  });

  it('ignores the memory tool while the feature is unavailable', async () => {
    const { runtime, agentToolRuntime, readConfigFile } = await createHarness({
      settings: { agentControlToolEnabled: false, agentWebToolEnabled: false, agentMemoryToolEnabled: true },
      memoryAvailable: false,
    });

    await runtime.buildManagedChildEnv();

    expect(agentToolRuntime.materializePlugin).not.toHaveBeenCalled();
    expect(await readConfigFile()).toEqual({ plugins: ['-opencode.browser'] });
  });
});

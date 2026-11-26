import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createResponseRecoveryOwner } from '../session-response-recovery/owner.js';
import { createRecoveryTransitions } from '../session-response-recovery/transitions.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { injectedEnvKeys } from '../injected-env.js';

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn();
const recordStartupPerformanceMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
  // `managed-process-registry.js` (imported transitively via lifecycle.js)
  // calls `promisify(execFile)` at module load, so the mock must expose a
  // function here. Lifecycle tests don't exercise the reaper path, so a plain
  // stub is enough; the registry's best-effort writes are no-ops on errors.
  execFile: vi.fn(),
}));
vi.mock('../diagnostics/startup-performance.js', () => ({
  recordStartupPerformance: recordStartupPerformanceMock,
}));

const { createOpenCodeLifecycleRuntime } = await import('./lifecycle.js');
const { createServerDiagnosticJournal } = await import('../diagnostics/server-journal.js');

const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalPath = process.env.PATH;
const originalFetch = globalThis.fetch;

afterEach(() => {
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
  recordStartupPerformanceMock.mockReset();
  globalThis.fetch = originalFetch;
  if (typeof originalOpencodeBinary === 'string') {
    process.env.OPENCODE_BINARY = originalOpencodeBinary;
  } else {
    delete process.env.OPENCODE_BINARY;
  }

  if (typeof originalPath === 'string') {
    process.env.PATH = originalPath;
  } else {
    delete process.env.PATH;
  }
});

const createMockChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 12345;
  child.kill = vi.fn(() => {
    child.signalCode = 'SIGTERM';
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  });
  return child;
};

const createRuntime = (overrides = {}, stateOverrides = {}, envOverrides = {}) => {
  const state = {
    openCodeWorkingDirectory: '/tmp/project',
    openCodeProcess: null,
    openCodePort: null,
    openCodeBaseUrl: null,
    currentRestartPromise: null,
    isRestartingOpenCode: false,
    openCodeApiPrefix: '',
    openCodeApiPrefixDetected: false,
    openCodeApiDetectionTimer: null,
    lastOpenCodeError: null,
    lastOpenCodeHealthFailure: null,
    lastManagedOpenCodeProcess: null,
    lastOpenCodeRestartDiagnostics: null,
    isOpenCodeReady: false,
    openCodeNotReadySince: 0,
    isExternalOpenCode: false,
    isShuttingDown: false,
    healthCheckInterval: null,
    expressApp: null,
    useWslForOpencode: false,
    resolvedWslBinary: null,
    resolvedWslOpencodePath: null,
    resolvedWslDistro: null,
    ...stateOverrides,
  };

  const runtime = createOpenCodeLifecycleRuntime({
    state,
    env: {
      ENV_CONFIGURED_OPENCODE_PORT: 45678,
      ENV_CONFIGURED_OPENCODE_HOST: null,
      ENV_EFFECTIVE_PORT: 3001,
      ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
      ENV_SKIP_OPENCODE_START: false,
      ...envOverrides,
    },
    syncToHmrState: vi.fn(),
    syncFromHmrState: vi.fn(),
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (route) => `http://127.0.0.1:45678${route}`,
    waitForReady: vi.fn(async () => true),
    normalizeApiPrefix: vi.fn(() => ''),
    applyOpencodeBinaryFromSettings: vi.fn(async () => null),
    checkOpenCodeBinary: async () => '2.0.19',
  ensureOpencodeCliEnv: vi.fn(),
    ensureLocalOpenCodeServerPassword: vi.fn(async () => 'password'),
    resolveManagedOpenCodeLaunchSpec: vi.fn((binary) => ({ binary, args: [], wrapperType: null })),
    setOpenCodePort: vi.fn((port) => {
      state.openCodePort = port;
    }),
    setDetectedOpenCodeApiPrefix: vi.fn(),
    setupProxy: vi.fn(),
    ensureOpenCodeApiPrefix: vi.fn(),
    clearResolvedOpenCodeBinary: vi.fn(),
    buildAugmentedPath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
    buildManagedOpenCodePath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
    // Never let a test touch the real `~/.local/share/opencode/opencode.db`.
    topUpV1SessionMigration: vi.fn(() => ({ status: 'skipped', missing: 0, revisited: 0, reason: 'no-database' })),
    getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({
      PATH: '/home/user/.bun/bin:/usr/local/bin:/usr/bin',
      SHELL_ONLY: 'yes',
      OPENCODE_PASSWORD: 'shell-password',
      OPENCODE_SERVER_PASSWORD: 'shell-password',
    })),
    ...overrides,
  });
  runtime.testState = state;
  return runtime;
};

describe('OpenCode lifecycle', () => {
  it('invalidates captured work immediately and drains it before restart rebind', async () => {
    let release;
    let invalidated = false;
    const held = new Promise(resolve => { release = resolve; });
    const runtime = createRuntime({ beforeOpenCodeRestart: () => { invalidated = true; return held; } },
      { isExternalOpenCode: true, openCodePort: 45678, isOpenCodeReady: true });
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ version: '2.2.5' }) }));
    const restarting = runtime.restartOpenCode('recovery-test');
    try {
      expect(invalidated).toBe(true);
      await Promise.resolve();
      expect(runtime.testState.isOpenCodeReady).toBe(true);
    } finally { release(); await restarting; }
  });
  it('uses the resolved binary directly on startup and managed restart without an env override', async () => {
    delete process.env.OPENCODE_BINARY;
    const binaries = ['/bundle one/opencode-cli/opencode', '/bundle two/opencode-cli/opencode'];
    const ensureOpencodeCliEnv = vi.fn()
      .mockReturnValueOnce(binaries[0])
      .mockReturnValueOnce(binaries[1]);
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
      return child;
    });
    globalThis.fetch = vi.fn(async () => ({ ok: false }));
    const runtime = createRuntime({ ensureOpencodeCliEnv });
    const firstServer = await runtime.startOpenCode();
    runtime.testState.openCodeProcess = firstServer;
    try {
      await runtime.restartOpenCode();
      expect(firstServer.signalCode).toBe('SIGTERM');
      expect(spawnMock.mock.calls.map(([binary]) => binary)).toEqual(binaries);
      expect(runtime.testState.lastOpenCodeLaunchDiagnostics.sourceBinary).toBe(binaries[1]);
      expect(process.env.OPENCODE_BINARY).toBeUndefined();
      for (const [, , options] of spawnMock.mock.calls) {
        expect(options.env).not.toHaveProperty('OPENCODE_BINARY');
      }
      // Credential reads take variable keys from the environment the current process got.
      expect(runtime.getManagedOpenCodeProcessEnv()).toBe(spawnMock.mock.calls[1][2].env);
      expect(runtime.getManagedOpenCodeProcessEnv()).toMatchObject({ SHELL_ONLY: 'yes' });
    } finally {
      await runtime.testState.openCodeProcess.close();
    }
  });

  it('journals managed launch, readiness, exit and restart as fixed actions only', async () => {
    const journal = createServerDiagnosticJournal();
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => {
        child.stderr.emit('data', 'plugin failed: token=secret-123 /private/file\n');
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    globalThis.fetch = vi.fn(async () => ({ ok: false }));
    const runtime = createRuntime({ diagnosticJournal: journal });
    const firstServer = await runtime.startOpenCode();
    runtime.testState.openCodeProcess = firstServer;
    try {
      await runtime.restartOpenCode();
      expect(journal.snapshot().events.map(({ action, detail }) => [action, detail])).toEqual([
        ['managed launch', 'attempt=1'],
        ['managed ready', 'attempt=1'],
        ['managed restart started', undefined],
        ['managed process exited', undefined],
        ['managed launch', 'attempt=1'],
        ['managed ready', 'attempt=1'],
        ['managed restart ready', undefined],
      ]);
      expect(spawnMock.mock.calls[0][2].env).not.toHaveProperty('OPENCODE_PRINT_LOGS');
      expect(JSON.stringify(journal.snapshot())).not.toMatch(/secret|private/);
    } finally {
      await runtime.testState.openCodeProcess.close();
    }
  });

  it('records an authoritative ready terminal event for external startup', async () => {
    const onEngineReady = vi.fn();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '2.2.5', pid: 1, urls: [], paths: { tmp: '/tmp' } }),
    }));
    const runtime = createRuntime({
      onEngineReady,
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
    });

    await runtime.bootstrapOpenCodeAtStartup();
    expect(onEngineReady).toHaveBeenCalled();

    expect(recordStartupPerformanceMock).toHaveBeenCalledWith('opencode.bootstrap.ready', {
      totalDurationMs: expect.any(Number),
      outcome: 'ready',
    });
    expect(recordStartupPerformanceMock).not.toHaveBeenCalledWith(
      'opencode.bootstrap.error',
      expect.anything(),
    );
    const terminalEvents = recordStartupPerformanceMock.mock.calls.filter(([phase]) => (
      phase === 'opencode.bootstrap.ready' || phase === 'opencode.bootstrap.error'
    ));
    expect(terminalEvents).toHaveLength(1);
  });

  it.each([
    { skip: true, stale: false },
    { skip: true, stale: true },
    { skip: false, stale: false },
    { skip: false, stale: true },
  ])('notifies exactly once after external bootstrap readiness, skip=$skip stale=$stale', async ({ skip, stale }) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'external-bootstrap-recovery-'));
    const owner = await createResponseRecoveryOwner({ dataDir, namespace: 'external-test', client: () => ({}), archiveStore: () => ({}) });
    await owner.suspend();
    const transitions = createRecoveryTransitions({ identity: () => 'test', suspend: () => owner.suspend(), resume: () => owner.resume() });
    expect(() => owner.admissions.begin('ses_test')).toThrow();
    let reads = 0;
    let notifications = 0;
    let listenerFinished = false;
    const fetchMock = vi.fn(async () => {
      reads++;
      // A retained HMR handle fails its health check before external attachment.
      if (stale && reads === 1) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ version: '2.2.5', pid: 1, urls: [], paths: { tmp: '/tmp' } }) };
    });
    globalThis.fetch = fetchMock;
    const runtime = createRuntime({
      reapManagedOrphanedProcesses: async () => ({ reaped: 0 }),
      onEngineReady: async () => {
        notifications++;
        expect(runtime.testState).toMatchObject({ isExternalOpenCode: true, isOpenCodeReady: true, openCodePort: 45678 });
        // Skip-start must prove readiness; auto-detection must also finish its final check.
        expect(reads).toBe((stale ? 1 : 0) + (skip ? 1 : 2));
        await transitions.ready();
        listenerFinished = true;
      },
    }, { openCodeProcess: stale ? createMockChild() : null, openCodePort: stale ? 45678 : null }, {
      ENV_SKIP_OPENCODE_START: skip, ENV_EFFECTIVE_PORT: 45678,
    });
    try {
      await runtime.bootstrapOpenCodeAtStartup();
      const ticket = owner.admissions.begin('ses_test');
      ticket.finish(true);
      await owner.admissions.drain('ses_test');
      expect(notifications).toBe(1);
      expect(listenerFinished).toBe(true);
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await owner.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('notifies recovery readiness when reusing a healthy HMR process', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ version: '2.2.5', pid: 1, urls: [], paths: { tmp: '/tmp' } }) }));
    const onEngineReady = vi.fn();
    const runtime = createRuntime({ onEngineReady, reapManagedOrphanedProcesses: async () => ({ reaped: 0 }) }, { openCodeProcess: createMockChild(), openCodePort: 45678 });
    await runtime.bootstrapOpenCodeAtStartup();
    expect(onEngineReady).toHaveBeenCalledTimes(1);
  });

  it('recovers an external OPENCODE_HOST connection using its configured endpoint', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '2.2.5', pid: 1, urls: [], paths: { tmp: '/tmp' } }),
    }));
    globalThis.fetch = fetchMock;
    const runtime = createRuntime({}, {
      openCodePort: null,
      openCodeBaseUrl: null,
      isExternalOpenCode: true,
    }, {
      ENV_CONFIGURED_OPENCODE_PORT: null,
      ENV_CONFIGURED_OPENCODE_HOST: { origin: 'http://seamus:4095', port: 4095 },
      ENV_EFFECTIVE_PORT: 4095,
    });

    await runtime.restartOpenCode();

    expect(runtime.getManagedOpenCodeProcessEnv()).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://seamus:4095/api/info',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(runtime.testState.openCodePort).toBe(4095);
    expect(runtime.testState.openCodeBaseUrl).toBe('http://seamus:4095');
    expect(runtime.testState.lastOpenCodeError).toBeNull();
  });

  it('retains the OPENCODE_HOST port after an external re-probe fails', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    const runtime = createRuntime({}, {
      openCodePort: 4095,
      openCodeBaseUrl: 'http://seamus:4095',
      isExternalOpenCode: true,
    }, {
      ENV_CONFIGURED_OPENCODE_PORT: null,
      ENV_CONFIGURED_OPENCODE_HOST: { origin: 'http://seamus:4095', port: 4095 },
      ENV_EFFECTIVE_PORT: 4095,
    });

    await expect(runtime.restartOpenCode()).rejects.toThrow(
      'External OpenCode server on port 4095 is not responding',
    );

    expect(runtime.testState.openCodePort).toBe(4095);
    expect(runtime.testState.openCodeBaseUrl).toBe('http://seamus:4095');
  });

  it('re-probes an external server that missed the startup readiness window', async () => {
    vi.useFakeTimers();
    let healthy = false;
    globalThis.fetch = vi.fn(async () => {
      if (!healthy) throw new Error('fetch failed');
      return { ok: true, json: async () => ({ version: '2.2.5', pid: 1, urls: [], paths: { tmp: '/tmp' } }) };
    });
    const runtime = createRuntime({ reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })) }, {}, {
      ENV_CONFIGURED_OPENCODE_PORT: null,
      ENV_CONFIGURED_OPENCODE_HOST: { origin: 'http://seamus:4095', port: 4095 },
      ENV_EFFECTIVE_PORT: 4095,
      ENV_SKIP_OPENCODE_START: true,
    });

    try {
      const bootstrap = runtime.bootstrapOpenCodeAtStartup();
      await vi.advanceTimersByTimeAsync(25_000);
      await bootstrap;
      expect(runtime.testState.isOpenCodeReady).toBe(false);

      healthy = true;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(runtime.testState.isOpenCodeReady).toBe(true);
      expect(runtime.testState.lastOpenCodeError).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  const externalLateStartRuntime = (overrides = {}) => createRuntime(
    { reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })), ...overrides },
    {},
    {
      ENV_CONFIGURED_OPENCODE_PORT: null,
      ENV_CONFIGURED_OPENCODE_HOST: { origin: 'http://seamus:4095', port: 4095 },
      ENV_EFFECTIVE_PORT: 4095,
      ENV_SKIP_OPENCODE_START: true,
    },
  );
  const supportedInfo = { version: '2.2.5', pid: 1, urls: [], paths: { tmp: '/tmp' } };

  it('bounds an external re-probe whose body stalls, then recovers on a later one', async () => {
    vi.useFakeTimers();
    let mode = 'down';
    const probesAfterStartup = [];
    globalThis.fetch = vi.fn(async () => {
      if (mode === 'down') throw new Error('fetch failed');
      probesAfterStartup.push(mode);
      if (mode === 'gone') throw new Error('fetch failed');
      if (mode === 'stall') {
        // Headers now, the body only long after the probe's timeout.
        return { ok: true, json: () => new Promise((resolve) => setTimeout(() => resolve(supportedInfo), 7_000)) };
      }
      return { ok: true, json: async () => supportedInfo };
    });
    const runtime = externalLateStartRuntime();

    try {
      const bootstrap = runtime.bootstrapOpenCodeAtStartup();
      await vi.advanceTimersByTimeAsync(25_000);
      await bootstrap;
      expect(runtime.testState.isOpenCodeReady).toBe(false);

      mode = 'stall';
      await vi.advanceTimersByTimeAsync(5_000);
      expect(probesAfterStartup).toEqual(['stall']);
      mode = 'gone';
      // The stalled probe has given up by now; its late body must not count.
      await vi.advanceTimersByTimeAsync(9_000);
      expect(probesAfterStartup).toEqual(['stall', 'gone']);
      expect(runtime.testState.isOpenCodeReady).toBe(false);

      mode = 'healthy';
      await vi.advanceTimersByTimeAsync(1_000);

      expect(probesAfterStartup).toEqual(['stall', 'gone', 'healthy']);
      expect(runtime.testState.isOpenCodeReady).toBe(true);
      expect(runtime.testState.lastOpenCodeError).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops an external re-probe answer that arrives after shutdown began', async () => {
    vi.useFakeTimers();
    let mode = 'down';
    let respond = null;
    globalThis.fetch = vi.fn(async () => {
      if (mode === 'down') throw new Error('fetch failed');
      return new Promise((resolve) => {
        respond = () => resolve({ ok: true, json: async () => supportedInfo });
      });
    });
    const syncToHmrState = vi.fn();
    const runtime = externalLateStartRuntime({ syncToHmrState });

    try {
      const bootstrap = runtime.bootstrapOpenCodeAtStartup();
      await vi.advanceTimersByTimeAsync(25_000);
      await bootstrap;
      expect(runtime.testState.isOpenCodeReady).toBe(false);

      mode = 'deferred';
      await vi.advanceTimersByTimeAsync(5_000);
      expect(respond).toBeTypeOf('function');
      const hmrSyncsBefore = syncToHmrState.mock.calls.length;

      runtime.testState.isShuttingDown = true;
      respond();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(runtime.testState.isOpenCodeReady).toBe(false);
      expect(syncToHmrState.mock.calls.length).toBe(hmrSyncsBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it('attaches to an OPENCODE_HOST running OpenCode v1 instead of starting a managed server', async () => {
    const requested = [];
    globalThis.fetch = vi.fn(async (url) => {
      const href = String(url);
      requested.push(href);
      if (href.endsWith('/global/health')) return Response.json({ healthy: true, version: '1.18.32' });
      return new Response('<html>OpenCode</html>', { headers: { 'content-type': 'text/html' } });
    });
    const runtime = createRuntime({
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
    }, {}, {
      ENV_CONFIGURED_OPENCODE_PORT: null,
      ENV_CONFIGURED_OPENCODE_HOST: { origin: 'http://seamus:4095', port: 4095 },
      ENV_EFFECTIVE_PORT: 4095,
    });

    await runtime.bootstrapOpenCodeAtStartup();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(requested).toContain('http://seamus:4095/global/health');
    expect(runtime.testState.isExternalOpenCode).toBe(true);
    expect(runtime.testState.isOpenCodeReady).toBe(false);
    expect(runtime.testState.openCodeBaseUrl).toBe('http://seamus:4095');
    expect(runtime.testState.openCodePort).toBe(4095);
    expect(runtime.testState.lastOpenCodeError).toContain('1.18.32');
  });

  it('warms only the last-used directory after a successful bootstrap', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-warm-'));
    const lastUsed = path.join(root, 'worktree-a');
    const otherProject = path.join(root, 'project-b');
    await fs.mkdir(lastUsed);
    await fs.mkdir(otherProject);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '2.2.5', pid: 1, urls: [], paths: { tmp: '/tmp' } }),
    }));
    globalThis.fetch = fetchMock;
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
      getWarmupDirectories: vi.fn(async () => [lastUsed, otherProject]),
    });

    await runtime.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const warmups = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/api/location'))
      .map(([url, init]) => [String(url), init.headers['x-opencode-directory']]);
    // Each warmed directory boots its whole MCP fleet on OpenCode 2 (#4018).
    // v2 reads the directory from the header, and only location routes start
    // one: `/api/session` is a global list.
    expect(warmups).toEqual([
      ['http://127.0.0.1:45678/api/location', encodeURIComponent(lastUsed)],
    ]);
    // Server-side reads without a directory of their own go to the warmed one.
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(lastUsed);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('answers null once the warmed default directory is no longer usable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-stale-'));
    const stale = path.join(root, 'worktree-a');
    await fs.mkdir(stale);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '2.2.5', pid: 1, urls: [], paths: { tmp: '/tmp' } }),
    }));
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
      getWarmupDirectories: vi.fn(async () => [stale]),
    });

    await runtime.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // While the directory is usable, it scopes default reads.
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(stale);

    // The project directory is removed while the server keeps running. The
    // cached default must not keep being handed to OpenCode: a stale path
    // makes every directory-scoped read answer 500 (the bug behind the quota
    // endpoints' "UnexpectedStatus: 500").
    await fs.rm(stale, { recursive: true, force: true });
    expect(runtime.getDefaultOpenCodeDirectory()).toBeNull();

    // A path that now points at a regular file is not a directory either.
    await fs.writeFile(stale, 'x');
    expect(runtime.getDefaultOpenCodeDirectory()).toBeNull();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('scopes default reads to the chats root while no project directory is usable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-no-project-'));
    const chats = path.join(root, 'chats');
    const project = path.join(root, 'project');
    await fs.mkdir(chats);
    await fs.mkdir(project);
    let warmup = [];
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '2.2.5', pid: 1, urls: [], paths: { tmp: '/tmp' } }),
    }));
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
      getWarmupDirectories: vi.fn(async () => warmup),
      noProjectDirectory: chats,
    });

    await runtime.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // No project: a read without a directory would start OpenCode over the
    // whole home, its working directory.
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(chats);
    expect(globalThis.fetch.mock.calls.filter(([url]) => String(url).endsWith('/api/location'))).toEqual([]);

    // A project opened later takes over once the warmup source names it.
    warmup = [project];
    await runtime.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(project);
    await fs.rm(root, { recursive: true, force: true });
  });

  // The UI stops a chat's location once the user leaves it. A read that went
  // to the chat used last at startup would start it again, every quota poll.
  it('scopes reads without a directory to the directory the user works in now', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-current-'));
    const leftChat = path.join(root, 'left-chat');
    const current = path.join(root, 'current');
    await fs.mkdir(leftChat);
    await fs.mkdir(current);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '2.2.5', pid: 1, urls: [], paths: { tmp: '/tmp' } }),
    }));
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
      getWarmupDirectories: vi.fn(async () => [leftChat]),
    });

    await runtime.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(leftChat);

    runtime.noteCurrentDirectory(current);
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(current);

    // A directory that is not there is never sent.
    runtime.noteCurrentDirectory(path.join(root, 'missing'));
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(current);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('advances to a currently-valid warmup directory when the cached default goes stale', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-replace-'));
    const stale = path.join(root, 'gone');
    const surviving = path.join(root, 'still-here');
    await fs.mkdir(stale);
    await fs.mkdir(surviving);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '2.2.5', pid: 1, urls: [], paths: { tmp: '/tmp' } }),
    }));
    // The warm pass offered both; only the first was cached as the default.
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
      getWarmupDirectories: vi.fn(async () => [stale, surviving]),
    });

    await runtime.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(stale);

    // Removing the first still leaves a valid directory: default reads keep
    // their location scope rather than dropping it entirely.
    await fs.rm(stale, { recursive: true, force: true });
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(surviving);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('re-resolves the settings-backed default when the cached one is stale', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-refresh-'));
    const stale = path.join(root, 'old-project');
    const navigated = path.join(root, 'new-project');
    await fs.mkdir(stale);
    await fs.mkdir(navigated);
    let current = stale;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '2.2.5', pid: 1, urls: [], paths: { tmp: '/tmp' } }),
    }));
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
      // Mirrors the real dep: the warmup source answers the settings'
      // lastDirectory, which moves as the user navigates.
      getWarmupDirectories: vi.fn(async () => [current]),
    });

    await runtime.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(stale);

    // The user navigated to another project while the old one vanished.
    await fs.rm(stale, { recursive: true, force: true });
    current = navigated;
    // First read drops the stale default and kicks the refresh; the next read
    // sees the re-resolved, currently-valid directory and scopes to it.
    expect(runtime.getDefaultOpenCodeDirectory()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(navigated);
    await fs.rm(root, { recursive: true, force: true });
  });

  // Windows chmod only toggles the read-only attribute, and root ignores the
  // permission bits, so neither can take read/execute away from a directory.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('treats a directory without read/execute permission as unusable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-perm-'));
    const locked = path.join(root, 'locked');
    await fs.mkdir(locked);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '2.2.5', pid: 1, urls: [], paths: { tmp: '/tmp' } }),
    }));
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
      getWarmupDirectories: vi.fn(async () => [locked]),
    });

    await runtime.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(locked);

    // OpenCode answers 500 FileSystem.realPath for a directory it cannot read
    // or traverse, same as for a missing one, so it must not be sent.
    await fs.chmod(locked, 0o000);
    try {
      expect(runtime.getDefaultOpenCodeDirectory()).toBeNull();
    } finally {
      await fs.chmod(locked, 0o755);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not scope the restart agent check to a directory that went stale', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-agent-'));
    const stale = path.join(root, 'worktree-a');
    await fs.mkdir(stale);
    const requested = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      requested.push([String(url), init?.headers?.['x-opencode-directory'] ?? null]);
      if (String(url).endsWith('/api/info')) {
        return { ok: true, json: async () => ({ version: '2.2.5', pid: 1, urls: [], paths: { tmp: '/tmp' } }) };
      }
      return { ok: true, json: async () => ({ data: [{ id: 'build' }] }) };
    });
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
      getWarmupDirectories: vi.fn(async () => [stale]),
    });

    await runtime.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await fs.rm(stale, { recursive: true, force: true });
    await expect(runtime.waitForAgentPresence('build', 500, 50)).resolves.toBeUndefined();

    const agentChecks = requested.filter(([url]) => url.endsWith('/api/agent'));
    expect(agentChecks.length).toBeGreaterThan(0);
    expect(agentChecks.every(([, directory]) => directory === null)).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('records an authoritative error terminal event when bootstrap fails', async () => {
    const runtime = createRuntime({
      syncFromHmrState: vi.fn(() => {
        throw new Error('bootstrap failed');
      }),
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
    });

    await runtime.bootstrapOpenCodeAtStartup();

    expect(recordStartupPerformanceMock).toHaveBeenCalledWith('opencode.bootstrap.error', {
      totalDurationMs: expect.any(Number),
      outcome: 'error',
    });
    expect(recordStartupPerformanceMock).not.toHaveBeenCalledWith(
      'opencode.bootstrap.ready',
      expect.anything(),
    );
    const terminalEvents = recordStartupPerformanceMock.mock.calls.filter(([phase]) => (
      phase === 'opencode.bootstrap.ready' || phase === 'opencode.bootstrap.error'
    ));
    expect(terminalEvents).toHaveLength(1);
  });

  describe('bootstrap retry', () => {
    const failingBootstrapRuntime = (error, stateOverrides) => createRuntime({
      syncFromHmrState: vi.fn(() => {
        throw error;
      }),
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
    }, stateOverrides);

    afterEach(() => {
      vi.useRealTimers();
    });

    it('keeps retrying a failed managed start at growing intervals', async () => {
      vi.useFakeTimers();
      const runtime = failingBootstrapRuntime(new Error('listener unavailable'));
      const bootstrap = vi.fn(async () => {
        await runtime.bootstrapOpenCodeAtStartup();
        runtime.scheduleBootstrapRetry(bootstrap);
      });

      await runtime.bootstrapOpenCodeAtStartup();
      expect(runtime.scheduleBootstrapRetry(bootstrap)).toBe(true);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(bootstrap).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(bootstrap).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(bootstrap).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(30_000 + 60_000 + 60_000);
      expect(bootstrap).toHaveBeenCalledTimes(5);
    });

    it('makes a restart asked for during a retry wait for it and then really restart', async () => {
      vi.useFakeTimers();
      const runtime = failingBootstrapRuntime(new Error('listener unavailable'));
      const retryRun = Promise.withResolvers();
      await runtime.bootstrapOpenCodeAtStartup();
      runtime.scheduleBootstrapRetry(() => retryRun.promise, vi.fn());
      await vi.advanceTimersByTimeAsync(5_000);

      const child = createMockChild();
      spawnMock.mockImplementationOnce(() => {
        queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
        return child;
      });
      const restart = runtime.restartOpenCode();
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnMock).not.toHaveBeenCalled();

      retryRun.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      await restart;
      expect(spawnMock).toHaveBeenCalledTimes(1);
      await runtime.testState.openCodeProcess.close();
    });

    it('waits for a restart in flight before retrying', async () => {
      vi.useFakeTimers();
      const runtime = failingBootstrapRuntime(new Error('listener unavailable'));
      const bootstrap = vi.fn(async () => {});
      await runtime.bootstrapOpenCodeAtStartup();
      runtime.scheduleBootstrapRetry(bootstrap, vi.fn());

      const restart = Promise.withResolvers();
      runtime.testState.currentRestartPromise = restart.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(bootstrap).not.toHaveBeenCalled();

      runtime.testState.currentRestartPromise = null;
      restart.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(bootstrap).toHaveBeenCalledTimes(1);
    });

    it('starts nothing when a restart has started OpenCode before the retry fires', async () => {
      vi.useFakeTimers();
      const runtime = failingBootstrapRuntime(new Error('listener unavailable'));
      const bootstrap = vi.fn(async () => {});
      const onAlreadyRunning = vi.fn();
      await runtime.bootstrapOpenCodeAtStartup();
      runtime.scheduleBootstrapRetry(bootstrap, onAlreadyRunning);

      runtime.testState.openCodeProcess = { close: vi.fn() };
      await vi.advanceTimersByTimeAsync(5_000);

      expect(bootstrap).not.toHaveBeenCalled();
      expect(onAlreadyRunning).toHaveBeenCalledTimes(1);
    });

    it('keeps the last error readable while a retry runs', async () => {
      const startFailure = new Error('spawn opencode ENOENT');
      const applyOpencodeBinaryFromSettings = vi.fn(async () => {
        expect(runtime.testState.lastOpenCodeError).toBe('earlier failure');
        throw startFailure;
      });
      const runtime = createRuntime({
        applyOpencodeBinaryFromSettings,
        reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
      }, { lastOpenCodeError: 'earlier failure' }, { ENV_CONFIGURED_OPENCODE_PORT: null, ENV_EFFECTIVE_PORT: null });

      await runtime.bootstrapOpenCodeAtStartup();

      expect(applyOpencodeBinaryFromSettings).toHaveBeenCalled();
      expect(runtime.testState.lastOpenCodeError).toBe(startFailure.message);
    });

    it('schedules nothing after a successful start', async () => {
      const runtime = createRuntime({
        reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
      }, { openCodeProcess: { close: vi.fn() }, openCodePort: 45678 });
      await runtime.bootstrapOpenCodeAtStartup();
      expect(runtime.scheduleBootstrapRetry(vi.fn())).toBe(false);
    });

    it('does not retry a binary the user has to change, an external server or a shutdown', async () => {
      const rejected = Object.assign(new Error('binary not found'), { code: 'OPENCODE_BINARY_INVALID' });
      const cases = [
        failingBootstrapRuntime(rejected),
        failingBootstrapRuntime(new Error('down'), { isExternalOpenCode: true }),
        failingBootstrapRuntime(new Error('down'), { isShuttingDown: true }),
      ];
      for (const runtime of cases) {
        await runtime.bootstrapOpenCodeAtStartup();
        expect(runtime.scheduleBootstrapRetry(vi.fn())).toBe(false);
      }
    });
  });

  it('does not count rapid transport-triggered checks as independent health failures', async () => {
    const close = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let now = 1;
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    const runtime = createRuntime({ now: () => now }, {
      openCodePort: 45678,
      openCodeProcess: {
        pid: null,
        exitCode: null,
        signalCode: null,
        close,
      },
      isOpenCodeReady: true,
    });

    for (let attempt = 0; attempt < 25; attempt += 1) {
      await runtime.triggerHealthCheck();
    }

    expect(close).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);

    now += 15_000;
    await runtime.triggerHealthCheck();

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('(2/20)'));
    warn.mockRestore();
  });

  it.each([
    {
      name: 'timeout',
      expectedClass: 'timeout',
      fetchResult: () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      },
    },
    {
      name: 'connection refusal',
      expectedClass: 'connection_refused',
      fetchResult: () => {
        const error = new Error('connect ECONNREFUSED 127.0.0.1:45678');
        error.code = 'ECONNREFUSED';
        throw error;
      },
    },
    {
      name: 'invalid JSON',
      expectedClass: 'invalid_response',
      fetchResult: () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      }),
    },
  ])('classifies and stores a counted $name health failure', async ({ expectedClass, fetchResult }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn(fetchResult);
    const runtime = createRuntime({}, {
      openCodePort: 45678,
      openCodeProcess: {
        pid: process.pid,
        exitCode: null,
        signalCode: null,
        close: vi.fn(async () => {}),
      },
      isOpenCodeReady: true,
    });

    await runtime.triggerHealthCheck();

    expect(runtime.testState.lastOpenCodeHealthFailure).toEqual({
      class: expectedClass,
      detail: expect.any(String),
      at: expect.any(String),
      source: 'immediate',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`class=${expectedClass}`));
    warn.mockRestore();
  });

  it('does not mistake a live managed process wrapper for an exited child', async () => {
    const close = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    const runtime = createRuntime({}, {
      openCodePort: 45678,
      openCodeProcess: {
        pid: process.pid,
        close,
      },
      isOpenCodeReady: true,
    });

    await runtime.triggerHealthCheck();

    expect(close).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('(1/20)'));
    warn.mockRestore();
  });

  it('restarts an exited managed process without waiting for the failure interval', async () => {
    const close = vi.fn(async () => {});
    const replacement = createMockChild();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        replacement.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return replacement;
    });
    const runtime = createRuntime({}, {
      openCodePort: 45678,
      openCodeProcess: {
        pid: null,
        exitCode: 1,
        signalCode: null,
        close,
      },
    });

    await runtime.triggerHealthCheck();

    expect(close).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('calls onOpenCodeRestarted after a successful managed restart', async () => {
    const close = vi.fn(async () => {});
    const replacement = createMockChild();
    const onOpenCodeRestarted = vi.fn();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        replacement.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return replacement;
    });
    const runtime = createRuntime({ onOpenCodeRestarted }, {
      openCodePort: 45678,
      openCodeProcess: {
        pid: null,
        exitCode: 1,
        signalCode: null,
        close,
      },
    });

    await runtime.triggerHealthCheck();

    expect(close).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // The restart completed on a (possibly new) port — the event-stream
    // upstreams must rebind so the UI keeps receiving events (#2638).
    expect(onOpenCodeRestarted).toHaveBeenCalledTimes(1);
  });

  it('retains post-listen stderr and exited process diagnostics across restart', async () => {
    const firstChild = createMockChild();
    const replacement = createMockChild();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => null,
    }));
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        replacement.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return replacement;
    });
    const runtime = createRuntime();
    const server = await runtime.startOpenCode();
    runtime.testState.openCodeProcess = server;

    firstChild.stderr.emit(
      'data',
      `${'x'.repeat(40 * 1024)}\ntoken=runtime-secret\nruntime worker failed after startup\n`,
    );
    firstChild.exitCode = 7;
    firstChild.emit('exit', 7, null);

    expect(server.exitCode).toBe(7);
    expect(Buffer.byteLength(server.stderrTail)).toBeLessThanOrEqual(32 * 1024);
    expect(server.stderrTail).not.toContain('runtime-secret');
    expect(server.stderrTail).toContain('runtime worker failed after startup');

    await runtime.triggerHealthCheck();

    expect(runtime.testState.lastOpenCodeRestartDiagnostics).toEqual({
      reason: 'immediate-process-exited',
      healthFailure: null,
      process: {
        pid: 12345,
        exitCode: 7,
        signalCode: null,
        stderrTail: expect.stringContaining('runtime worker failed after startup'),
        alive: false,
      },
      busySessionCount: 0,
      at: expect.any(String),
    });
    expect(runtime.testState.lastManagedOpenCodeProcess).toEqual({
      pid: 12345,
      exitCode: 7,
      signalCode: null,
      stderrTail: expect.stringContaining('runtime worker failed after startup'),
    });

    await runtime.testState.openCodeProcess.close();
    warn.mockRestore();
  });

  it('redacts Authorization scheme credentials from stderr diagnostics', async () => {
    const firstChild = createMockChild();
    const replacement = createMockChild();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => null,
    }));
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        replacement.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return replacement;
    });
    const runtime = createRuntime();
    const server = await runtime.startOpenCode();
    runtime.testState.openCodeProcess = server;

    firstChild.stderr.emit(
      'data',
      'request rejected: Authorization: Basic dXNlcjpwYXNz\n'
      + 'authorization: basic bG93ZXI6Y2FzZQ==\n'
      + 'Authorization: Bearer fake-bearer-token-value\n'
      + 'falling back to basic health monitor\n'
      + 'runtime worker failed after startup\n',
    );
    firstChild.exitCode = 7;
    firstChild.emit('exit', 7, null);

    expect(server.stderrTail).not.toContain('dXNlcjpwYXNz');
    expect(server.stderrTail).not.toContain('bG93ZXI6Y2FzZQ');
    expect(server.stderrTail).not.toContain('fake-bearer-token-value');
    expect(server.stderrTail).toContain('falling back to basic health monitor');
    expect(server.stderrTail).toContain('runtime worker failed after startup');

    await runtime.triggerHealthCheck();

    const diagnosticsTail = runtime.testState.lastOpenCodeRestartDiagnostics.process.stderrTail;
    expect(diagnosticsTail).not.toContain('dXNlcjpwYXNz');
    expect(diagnosticsTail).not.toContain('bG93ZXI6Y2FzZQ');
    expect(diagnosticsTail).not.toContain('fake-bearer-token-value');
    expect(diagnosticsTail).toContain('falling back to basic health monitor');
    expect(diagnosticsTail).toContain('runtime worker failed after startup');

    await runtime.testState.openCodeProcess.close();
    warn.mockRestore();
  });

  it('does not call onOpenCodeRestarted when a managed restart fails', async () => {
    const close = vi.fn(async () => {});
    const onOpenCodeRestarted = vi.fn();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => {
        child.emit('error', new Error('spawn failed'));
      });
      return child;
    });
    const runtime = createRuntime({ onOpenCodeRestarted }, {
      openCodePort: 45678,
      openCodeProcess: {
        pid: null,
        exitCode: 1,
        signalCode: null,
        close,
      },
    });

    // triggerHealthCheck logs instead of rethrowing; call restartOpenCode
    // directly to observe the failure result.
    await expect(runtime.restartOpenCode()).rejects.toThrow();

    expect(onOpenCodeRestarted).not.toHaveBeenCalled();
  });

  it('runs a whileStopped task between stopping and starting managed OpenCode', async () => {
    const order = [];
    const close = vi.fn(async () => { order.push('close'); });
    globalThis.fetch = vi.fn(async () => ({ ok: false, json: async () => null }));
    spawnMock.mockImplementationOnce(() => {
      order.push('spawn');
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
      return child;
    });
    const runtime = createRuntime({}, {
      openCodePort: 45678,
      openCodeProcess: { pid: null, exitCode: null, signalCode: null, close },
    });

    await runtime.restartOpenCode('opencode-upgrade', { whileStopped: async () => { order.push('task'); } });

    expect(order).toEqual(['close', 'task', 'spawn']);
    await runtime.testState.openCodeProcess.close();
  });

  it('starts managed OpenCode again when the whileStopped task fails, then reports the failure', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, json: async () => null }));
    spawnMock.mockImplementationOnce(() => {
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
      return child;
    });
    const runtime = createRuntime({}, {
      openCodePort: 45678,
      openCodeProcess: { pid: null, exitCode: null, signalCode: null, close: vi.fn(async () => {}) },
    });

    await expect(runtime.restartOpenCode('opencode-upgrade', {
      whileStopped: async () => { throw new Error('upgrade failed'); },
    })).rejects.toThrow('upgrade failed');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(runtime.testState.isOpenCodeReady).toBe(true);
    expect(runtime.testState.lastOpenCodeError).toBeNull();
    await runtime.testState.openCodeProcess.close();
  });

  it('onEngineReady fires after the first start and after each restart', async () => {
    const onEngineReady = vi.fn();
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
      return child;
    });
    globalThis.fetch = vi.fn(async () => ({ ok: false }));
    const runtime = createRuntime({ onEngineReady });

    runtime.testState.openCodeProcess = await runtime.startOpenCode();
    expect(onEngineReady).toHaveBeenCalledTimes(1);
    try {
      await runtime.restartOpenCode();
      expect(onEngineReady).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.testState.openCodeProcess.close();
    }
  });

  it('onEngineReady does not fire after a failed start', async () => {
    const onEngineReady = vi.fn();
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
      return child;
    });
    const runtime = createRuntime({ onEngineReady });

    await expect(runtime.startOpenCode()).rejects.toThrow();

    expect(onEngineReady).not.toHaveBeenCalled();
  });

  it('a throwing onEngineReady listener does not fail the start', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
      return child;
    });
    globalThis.fetch = vi.fn(async () => ({ ok: false }));
    const runtime = createRuntime({ onEngineReady: () => { throw new Error('listener broke'); } });

    const server = await runtime.startOpenCode();

    expect(server.url).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(expect.any(String), 'listener broke');
    await server.close();
    warn.mockRestore();
  });

  // Holds the first start in its binary check, before it has spawned anything,
  // until the test lets it go: the window in which a restart used to find no
  // process to close.
  const holdFirstBinaryCheck = () => {
    let entered;
    let release;
    const firstCheckEntered = new Promise((resolve) => { entered = resolve; });
    const firstCheckReleased = new Promise((resolve) => { release = resolve; });
    let checks = 0;
    const checkOpenCodeBinary = async () => {
      checks += 1;
      if (checks === 1) {
        entered();
        await firstCheckReleased;
      }
      return '2.2.5';
    };
    return { checkOpenCodeBinary, firstCheckEntered, releaseFirstCheck: () => release() };
  };

  it('a restart requested during the first start leaves exactly one live process', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '2.2.5', pid: 1, urls: [], paths: { tmp: '/tmp' } }),
    }));
    const children = [];
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      child.pid = 2147483600 + children.length;
      children.push(child);
      queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
      return child;
    });
    const { checkOpenCodeBinary, firstCheckEntered, releaseFirstCheck } = holdFirstBinaryCheck();
    const onEngineReady = vi.fn();
    const runtime = createRuntime(
      { reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })), checkOpenCodeBinary, onEngineReady },
      {},
      { ENV_EFFECTIVE_PORT: null, ENV_CONFIGURED_OPENCODE_PORT: null },
    );

    const boot = runtime.bootstrapOpenCodeAtStartup();
    await firstCheckEntered;
    const restart = runtime.restartOpenCode('catalog');
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirstCheck();
    await Promise.all([boot, restart]);

    const live = children.filter((child) => child.kill.mock.calls.length === 0);
    try {
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(live).toHaveLength(1);
      expect(children.filter((child) => child.kill.mock.calls.length > 0)).toEqual([children[0]]);
      expect(live).toEqual([children[1]]);
      expect(runtime.testState.openCodeProcess.pid).toBe(children[1].pid);
      expect(onEngineReady).toHaveBeenCalledTimes(2);
    } finally {
      live.forEach((child) => child.kill());
    }
  });

  it('a restart requested before the first start joins the queue gives exactly one spawn', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '2.2.5', pid: 1, urls: [], paths: { tmp: '/tmp' } }),
    }));
    const children = [];
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      child.pid = 2147483620 + children.length;
      children.push(child);
      queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
      return child;
    });
    let releaseReap;
    const reapReleased = new Promise((resolve) => { releaseReap = resolve; });
    let reapEntered;
    const reapStarted = new Promise((resolve) => { reapEntered = resolve; });
    const reapManagedOrphanedProcesses = vi.fn(async () => {
      reapEntered();
      await reapReleased;
      return { reaped: 0 };
    });
    const { checkOpenCodeBinary, firstCheckEntered, releaseFirstCheck } = holdFirstBinaryCheck();
    const onEngineReady = vi.fn();
    const runtime = createRuntime(
      { reapManagedOrphanedProcesses, checkOpenCodeBinary, onEngineReady },
      {},
      { ENV_EFFECTIVE_PORT: null, ENV_CONFIGURED_OPENCODE_PORT: null },
    );

    const boot = runtime.bootstrapOpenCodeAtStartup();
    await reapStarted;
    const restart = runtime.restartOpenCode('catalog');
    await firstCheckEntered;
    releaseReap();
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirstCheck();
    await Promise.all([boot, restart]);

    const live = children.filter((child) => child.kill.mock.calls.length === 0);
    try {
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(live).toEqual([children[0]]);
      expect(runtime.testState.openCodeProcess.pid).toBe(children[0].pid);
      expect(onEngineReady).toHaveBeenCalledTimes(1);
    } finally {
      live.forEach((child) => child.kill());
    }
  });

  it('the first start still replaces a stale process carried over from a hot reload', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '2.2.5', pid: 1, urls: [], paths: { tmp: '/tmp' } }),
    }));
    const child = createMockChild();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
      return child;
    });
    const stale = { pid: null, exitCode: 1, signalCode: null, close: vi.fn(async () => {}) };
    const runtime = createRuntime(
      { reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })) },
      { openCodeProcess: stale },
      { ENV_EFFECTIVE_PORT: null, ENV_CONFIGURED_OPENCODE_PORT: null },
    );

    await runtime.bootstrapOpenCodeAtStartup();

    try {
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(runtime.testState.openCodeProcess).not.toBe(stale);
      expect(runtime.testState.openCodeProcess.pid).toBe(child.pid);
    } finally {
      child.kill();
    }
  });

  it('a failed first start does not block a later restart', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '2.2.5', pid: 1, urls: [], paths: { tmp: '/tmp' } }),
    }));
    const children = [];
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      child.pid = 2147483610 + children.length;
      children.push(child);
      if (children.length <= 2) {
        queueMicrotask(() => {
          child.exitCode = 1;
          child.emit('exit', 1, null);
        });
      } else {
        queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
      }
      return child;
    });
    const { checkOpenCodeBinary, firstCheckEntered, releaseFirstCheck } = holdFirstBinaryCheck();
    const runtime = createRuntime(
      { reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })), checkOpenCodeBinary },
      {},
      { ENV_EFFECTIVE_PORT: null, ENV_CONFIGURED_OPENCODE_PORT: null },
    );

    const boot = runtime.bootstrapOpenCodeAtStartup();
    await firstCheckEntered;
    const restart = runtime.restartOpenCode('catalog');
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirstCheck();
    await Promise.all([boot, restart]);

    const live = children.filter((child) => child.exitCode === null && child.kill.mock.calls.length === 0);
    try {
      expect(spawnMock).toHaveBeenCalledTimes(3);
      expect(live).toEqual([children[2]]);
      expect(runtime.testState.openCodeProcess.pid).toBe(children[2].pid);
    } finally {
      live.forEach((child) => child.kill());
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('launches managed OpenCode with the managed PATH', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime();
    const server = await runtime.startOpenCode();
    const [binary, args, options] = spawnMock.mock.calls[0];

    expect(binary).toBe('opencode');
    expect(args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '45678']);
    expect(options.env.PATH).toBe('/home/user/.bun/bin:/usr/local/bin:/usr/bin');
    expect(options.env.SHELL_ONLY).toBe('yes');
    expect(options.env.OPENCODE_PASSWORD).toBe('password');
    expect(options.env.OPENCODE_SERVER_PASSWORD).toBe('password');
    expect(server.exitCode).toBeNull();
    expect(server.signalCode).toBeNull();

    await server.close();
    expect(server.signalCode).toBe('SIGTERM');
  });

  it('launches the bundled server through its launch spec on every platform', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    const entry = '/Applications/OpenChamber.app/Contents/Resources/opencode-server/serve.mjs';
    const runtime = createRuntime({
      ensureOpencodeCliEnv: vi.fn(() => entry),
      resolveManagedOpenCodeLaunchSpec: vi.fn((binary) => (binary === entry
        ? { binary: '/Applications/OpenChamber.app/Contents/MacOS/OpenChamber', args: [entry], env: { ELECTRON_RUN_AS_NODE: '1' }, wrapperType: 'bundled-server' }
        : { binary, args: [], wrapperType: null })),
    });

    const server = await runtime.startOpenCode();
    const [binary, args, options] = spawnMock.mock.calls[0];

    expect(binary).toBe('/Applications/OpenChamber.app/Contents/MacOS/OpenChamber');
    expect(args).toEqual([entry, 'serve', ...(process.platform === 'win32' ? ['--stdio'] : []), '--hostname', '127.0.0.1', '--port', '45678']);
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(options.env.OPENCODE_SERVER_PASSWORD).toBe('password');

    await server.close();
  });

  it('launches managed OpenCode on the configured bind hostname', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://0.0.0.0:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({}, {}, { ENV_CONFIGURED_OPENCODE_HOSTNAME: '0.0.0.0' });
    const server = await runtime.startOpenCode();
    const [binary, args] = spawnMock.mock.calls[0];

    expect(binary).toBe('opencode');
    expect(args).toEqual(['serve', '--hostname', '0.0.0.0', '--port', '45678']);

    await server.close();
    expect(server.signalCode).toBe('SIGTERM');
  });

  it('removes AppImage launcher entries from the managed OpenCode launch env', async () => {
    delete process.env.OPENCODE_BINARY;
    const previous = { APPDIR: process.env.APPDIR, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH };
    process.env.APPDIR = '/tmp/.mount_OpenChAbC123';
    process.env.LD_LIBRARY_PATH = '/tmp/.mount_OpenChAbC123/usr/lib:/opt/x:';
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    try {
      const runtime = createRuntime();
      const server = await runtime.startOpenCode();
      const [, , options] = spawnMock.mock.calls[0];

      expect(options.env.LD_LIBRARY_PATH).toBe('/opt/x');

      await server.close();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('strips AppImage ARGV0 from managed OpenCode launch env', async () => {
    delete process.env.OPENCODE_BINARY;
    const previousArgv0 = process.env.ARGV0;
    process.env.ARGV0 = '/path/to/OpenChamber/OpenChamber-1.17.2-linux-x86_64.AppImage';
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    try {
      const runtime = createRuntime({
        getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({
          PATH: '/home/user/.bun/bin:/usr/local/bin:/usr/bin',
          ARGV0: '/leaked/from/shell/snapshot.AppImage',
          SHELL_ONLY: 'yes',
        })),
      });
      const server = await runtime.startOpenCode();
      const [, , options] = spawnMock.mock.calls[0];

      expect(options.env).not.toHaveProperty('ARGV0');
      expect(options.env.SHELL_ONLY).toBe('yes');
      expect(options.env.PATH).toBe('/home/user/.bun/bin:/usr/local/bin:/usr/bin');

      await server.close();
    } finally {
      if (previousArgv0 === undefined) delete process.env.ARGV0;
      else process.env.ARGV0 = previousArgv0;
    }
  });

  it('passes the user variables to OpenCode under the variables OpenChamber owns', async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    const getUserEnvironment = vi.fn(() => ({
      DATABASE_URL: 'postgres://db',
      PATH: '/opt/tools/bin',
      OPENCODE_PASSWORD: 'user-password',
      OPENCHAMBER_AGENT_TOOL_TOKEN: 'user-token',
    }));
    const getManagedOpenCodeEnv = vi.fn(async () => ({ OPENCHAMBER_AGENT_TOOL_TOKEN: 'ephemeral' }));

    const runtime = createRuntime({ getUserEnvironment, getManagedOpenCodeEnv });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(options.env.DATABASE_URL).toBe('postgres://db');
    expect(options.env.PATH).toBe('/opt/tools/bin:/home/user/.bun/bin:/usr/local/bin:/usr/bin');
    expect(options.env.OPENCODE_PASSWORD).toBe('password');
    expect(options.env.OPENCHAMBER_AGENT_TOOL_TOKEN).toBe('ephemeral');
    expect(runtime.getManagedOpenCodeProcessEnv().DATABASE_URL).toBe('postgres://db');
    // The replaced values are recorded as OpenChamber's; the user's are not.
    const injected = injectedEnvKeys(options.env);
    for (const key of ['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD', 'OPENCHAMBER_AGENT_TOOL_TOKEN']) {
      expect(injected.has(key)).toBe(true);
    }
    expect(injected.has('DATABASE_URL')).toBe(false);
    expect(injected.has('PATH')).toBe(false);

    await server.close();
  });

  it('adds managed OpenChamber tool environment without allowing it to replace launch invariants', async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    const getManagedOpenCodeEnv = vi.fn(async () => ({
      OPENCODE_CONFIG_CONTENT: '{"plugin":["file:///tool.js"]}',
      OPENCHAMBER_AGENT_TOOL_TOKEN: 'ephemeral',
      PATH: '/untrusted/path',
      OPENCODE_PASSWORD: 'untrusted-password',
      OPENCODE_SERVER_PASSWORD: 'untrusted-password',
    }));

    const runtime = createRuntime({ getManagedOpenCodeEnv });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(getManagedOpenCodeEnv).toHaveBeenCalledOnce();
    expect(options.env.OPENCODE_CONFIG_CONTENT).toBe('{"plugin":["file:///tool.js"]}');
    expect(options.env.OPENCHAMBER_AGENT_TOOL_TOKEN).toBe('ephemeral');
    expect(options.env.PATH).toBe('/home/user/.bun/bin:/usr/local/bin:/usr/bin');
    expect(options.env.OPENCODE_PASSWORD).toBe('password');
    expect(options.env.OPENCODE_SERVER_PASSWORD).toBe('password');

    await server.close();
  });

  it('mirrors Google credential env aliases into the managed OpenCode environment', async () => {
    const previousGemini = process.env.GEMINI_API_KEY;
    const previousGoogleGen = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const previousGoogle = process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = 'AIza-from-gemini';
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    try {
      const child = createMockChild();
      spawnMock.mockImplementationOnce(() => {
        queueMicrotask(() => {
          child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
        });
        return child;
      });

      const runtime = createRuntime();
      const server = await runtime.startOpenCode();
      const [, , options] = spawnMock.mock.calls[0];

      expect(options.env.GEMINI_API_KEY).toBe('AIza-from-gemini');
      expect(options.env.GOOGLE_API_KEY).toBe('AIza-from-gemini');
      expect(options.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe('AIza-from-gemini');

      await server.close();
    } finally {
      if (typeof previousGemini === 'string') {
        process.env.GEMINI_API_KEY = previousGemini;
      } else {
        delete process.env.GEMINI_API_KEY;
      }
      if (typeof previousGoogleGen === 'string') {
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = previousGoogleGen;
      } else {
        delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      }
      if (typeof previousGoogle === 'string') {
        process.env.GOOGLE_API_KEY = previousGoogle;
      } else {
        delete process.env.GOOGLE_API_KEY;
      }
    }
  });

  it('falls back to buildAugmentedPath when buildManagedOpenCodePath is not provided', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({
      buildManagedOpenCodePath: undefined,
      buildAugmentedPath: vi.fn(() => '/home/user/.cargo/bin:/usr/local/bin'),
    });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(options.env.PATH).toBe('/home/user/.cargo/bin:/usr/local/bin');

    await server.close();
  });

  it('falls back to process.env.PATH when neither build function is provided', async () => {
    delete process.env.OPENCODE_BINARY;
    process.env.PATH = '/usr/bin:/bin';
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({
      buildManagedOpenCodePath: undefined,
      buildAugmentedPath: undefined,
    });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(options.env.PATH).toBe('/usr/bin:/bin');

    await server.close();
  });

  it('reports the binary when managed OpenCode exits before becoming ready', async () => {
    delete process.env.OPENCODE_BINARY;
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.emit('exit', null, 'SIGTERM');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        secondChild.emit('exit', null, 'SIGTERM');
      });
      return secondChild;
    });

    const runtime = createRuntime();

    await expect(runtime.startOpenCode()).rejects.toThrow('OpenCode process exited before serving with signal SIGTERM. Binary used: opencode. No stdout/stderr captured');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry managed startup when the configured OpenCode binary is invalid', async () => {
    delete process.env.OPENCODE_BINARY;
    const error = new Error('Configured OpenCode binary not found: /missing/opencode');
    error.code = 'OPENCODE_BINARY_INVALID';
    const applyOpencodeBinaryFromSettings = vi.fn(async () => {
      throw error;
    });

    const runtime = createRuntime({ applyOpencodeBinaryFromSettings });

    await expect(runtime.startOpenCode()).rejects.toThrow('Configured OpenCode binary not found: /missing/opencode');
    expect(applyOpencodeBinaryFromSettings).toHaveBeenCalledTimes(1);
    expect(applyOpencodeBinaryFromSettings).toHaveBeenCalledWith({ strict: true });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('retries managed OpenCode startup once after a pre-ready exit', async () => {
    delete process.env.OPENCODE_BINARY;
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.emit('exit', null, 'SIGTERM');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        secondChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return secondChild;
    });

    const runtime = createRuntime();
    const server = await runtime.startOpenCode();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    await server.close();
  });

  it('tops up the v1 session migration before spawning managed OpenCode', async () => {
    const calls = [];
    const topUpV1SessionMigration = vi.fn(() => {
      calls.push('top-up');
      return { status: 'scheduled', missing: 3, revisited: 0 };
    });
    spawnMock.mockImplementation(() => {
      calls.push('spawn');
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
      return child;
    });
    globalThis.fetch = vi.fn(async () => ({ ok: false }));

    const getUserEnvironment = vi.fn(() => ({ XDG_DATA_HOME: '/custom/data' }));
    const runtime = createRuntime({ topUpV1SessionMigration, getUserEnvironment });
    await runtime.startOpenCode();

    expect(topUpV1SessionMigration).toHaveBeenCalledTimes(1);
    expect(topUpV1SessionMigration.mock.calls[0][0].env.XDG_DATA_HOME).toBe('/custom/data');
    expect(spawnMock.mock.calls[0][2].env.XDG_DATA_HOME).toBe('/custom/data');
    expect(calls).toEqual(['top-up', 'spawn']);
  });

  it('leaves the v1 migration state alone when the bundled server, which imports nothing, is launched', async () => {
    const topUpV1SessionMigration = vi.fn(() => ({ status: 'scheduled', missing: 3, revisited: 0 }));
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
      return child;
    });
    globalThis.fetch = vi.fn(async () => ({ ok: false }));
    const binaries = ['/bundle/opencode-server/serve.mjs', '/usr/local/bin/opencode'];
    const ensureOpencodeCliEnv = vi.fn(() => binaries[0]);
    const runtime = createRuntime({ topUpV1SessionMigration, ensureOpencodeCliEnv, isBundledOpenCodePath: (binary) => binary === binaries[0] });

    await (await runtime.startOpenCode()).close();
    expect(topUpV1SessionMigration).not.toHaveBeenCalled();

    ensureOpencodeCliEnv.mockReturnValue(binaries[1]);
    await (await runtime.startOpenCode()).close();
    expect(topUpV1SessionMigration).toHaveBeenCalledTimes(1);
  });

  it('reports no launched data home after a restart failed before its launch, and starts again on the next restart', async () => {
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
      return child;
    });
    globalThis.fetch = vi.fn(async () => ({ ok: false }));
    const homes = ['/accounts/a/share'];
    const getManagedOpenCodeEnv = vi.fn(async () => {
      const home = homes.at(-1);
      if (!home) throw new Error('This account cannot start the engine');
      return { XDG_DATA_HOME: home };
    });
    const runtime = createRuntime({ getManagedOpenCodeEnv });
    expect(runtime.getManagedOpenCodeProcessEnv()).toBeNull();
    runtime.testState.openCodeProcess = await runtime.startOpenCode();
    expect(runtime.getManagedOpenCodeProcessEnv().XDG_DATA_HOME).toBe('/accounts/a/share');

    homes.push(null);
    await expect(runtime.restartOpenCode('account switch')).rejects.toThrow('This account cannot start the engine');
    expect(runtime.testState.openCodeProcess).toBeNull();
    expect(runtime.getManagedOpenCodeProcessEnv()).toBeNull();

    const spawned = spawnMock.mock.calls.length;
    await runtime.triggerHealthCheck();
    expect(spawnMock).toHaveBeenCalledTimes(spawned);

    homes.pop();
    await runtime.restartOpenCode('switched back');
    expect(spawnMock).toHaveBeenCalledTimes(spawned + 1);
    expect(runtime.testState.openCodeProcess).not.toBeNull();
    expect(runtime.getManagedOpenCodeProcessEnv().XDG_DATA_HOME).toBe('/accounts/a/share');
    await runtime.testState.openCodeProcess.close();
  });

  it('hands the top-up the data dir the managed OpenCode starts with', async () => {
    const topUpV1SessionMigration = vi.fn(() => ({ status: 'skipped', missing: 0, revisited: 0, reason: 'no-database' }));
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
      return child;
    });
    globalThis.fetch = vi.fn(async () => ({ ok: false }));

    const runtime = createRuntime({
      topUpV1SessionMigration,
      getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({ XDG_DATA_HOME: '/shell/share', SHELL_ONLY: 'yes' })),
      getManagedOpenCodeEnv: vi.fn(async () => ({ XDG_DATA_HOME: '/engine/share', OPENCODE_DB: 'opencode.db' })),
    });
    await runtime.startOpenCode();

    const [[{ env }]] = topUpV1SessionMigration.mock.calls;
    const [, , options] = spawnMock.mock.calls[0];
    expect(env.XDG_DATA_HOME).toBe('/engine/share');
    expect(env.OPENCODE_DB).toBe('opencode.db');
    expect(env.SHELL_ONLY).toBe('yes');
    expect(options.env.XDG_DATA_HOME).toBe(env.XDG_DATA_HOME);
    expect(options.env.OPENCODE_DB).toBe(env.OPENCODE_DB);
  });

  it('leaves a managed variable set to undefined out of the managed OpenCode env', async () => {
    process.env.WITHHELD_ENGINE_SECRET = 'from-process';
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
      return child;
    });
    globalThis.fetch = vi.fn(async () => ({ ok: false }));
    try {
      const runtime = createRuntime({
        getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({ WITHHELD_ENGINE_SECRET: 'from-shell' })),
        getManagedOpenCodeEnv: vi.fn(async () => ({ WITHHELD_ENGINE_SECRET: undefined })),
      });
      await runtime.startOpenCode();
      const [, , options] = spawnMock.mock.calls[0];
      expect(Object.hasOwn(options.env, 'WITHHELD_ENGINE_SECRET')).toBe(false);
    } finally {
      delete process.env.WITHHELD_ENGINE_SECRET;
    }
  });

  it('checks the binary with the same engine env the managed OpenCode starts with', async () => {
    const checkOpenCodeBinary = vi.fn(async () => '2.2.5');
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
      return child;
    });
    globalThis.fetch = vi.fn(async () => ({ ok: false }));

    const runtime = createRuntime({
      checkOpenCodeBinary,
      getManagedOpenCodeEnv: vi.fn(async () => ({ XDG_DATA_HOME: '/engine/share', XDG_CACHE_HOME: '/engine/cache' })),
    });
    await runtime.startOpenCode();

    const [[, { env }]] = checkOpenCodeBinary.mock.calls;
    const [, , options] = spawnMock.mock.calls[0];
    expect(env.XDG_DATA_HOME).toBe('/engine/share');
    expect(env.XDG_CACHE_HOME).toBe('/engine/cache');
    expect(env.PATH).toBe(process.env.PATH);
    expect(options.env.XDG_DATA_HOME).toBe(env.XDG_DATA_HOME);
    expect(options.env.XDG_CACHE_HOME).toBe(env.XDG_CACHE_HOME);
  });


});

describe('killProcessOnPort on Windows', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  const setPlatform = (platform) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  };

  it('force-kills the process listening on the target port via taskkill', () => {
    setPlatform('win32');
    const orphanPid = 54321;
    spawnSyncMock.mockImplementation((cmd) => {
      if (cmd === 'powershell') {
        return { stdout: `${orphanPid}\r\n` };
      }
      return { stdout: '' };
    });

    const runtime = createRuntime();
    runtime.killProcessOnPort(45678);

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'powershell',
      expect.arrayContaining([expect.stringContaining('-LocalPort 45678')]),
      expect.objectContaining({ windowsHide: true })
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', String(orphanPid), '/F'],
      expect.objectContaining({ windowsHide: true })
    );
  });

  it('never force-kills its own process id', () => {
    setPlatform('win32');
    spawnSyncMock.mockImplementation((cmd) => {
      if (cmd === 'powershell') {
        return { stdout: `${process.pid}\r\n` };
      }
      return { stdout: '' };
    });

    const runtime = createRuntime();
    runtime.killProcessOnPort(45678);

    expect(spawnSyncMock).not.toHaveBeenCalledWith('taskkill', expect.anything(), expect.anything());
  });

  it('does nothing when no process is listening on the target port', () => {
    setPlatform('win32');
    spawnSyncMock.mockImplementation((cmd) => {
      if (cmd === 'powershell') {
        return { stdout: '' };
      }
      return { stdout: '' };
    });

    const runtime = createRuntime();
    runtime.killProcessOnPort(45678);

    expect(spawnSyncMock).not.toHaveBeenCalledWith('taskkill', expect.anything(), expect.anything());
  });
});

it('shares the managed CLI preflight with desktop while startup is pending', async () => {
  let finish;
  let entered;
  const checking = new Promise(resolve => { entered = resolve; });
  const check = new Promise(resolve => { finish = resolve; });
  let checks = 0;
  const runtime = createRuntime({
    checkOpenCodeBinary: () => { checks += 1; entered(); return check; },
    ensureOpencodeCliEnv: () => '/tmp/opencode',
  });
  spawnMock.mockImplementation(() => {
    const child = createMockChild();
    queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
    return child;
  });
  expect(await runtime.getManagedOpenCodePreflight()).toBe(false);
  const starting = runtime.startOpenCode();
  await checking;
  const desktopVerdict = runtime.getManagedOpenCodePreflight();
  expect(runtime.testState.isOpenCodeReady).toBe(false);
  finish('2.2.5');
  expect(await desktopVerdict).toBe(true);
  expect(checks).toBe(1);
  const server = await starting;
  try {
    expect(await runtime.getManagedOpenCodePreflight()).toBe(true);
    runtime.testState.isExternalOpenCode = true;
    expect(await runtime.getManagedOpenCodePreflight()).toBe(false);
    runtime.testState.isExternalOpenCode = false;
    runtime.testState.isShuttingDown = true;
    expect(await runtime.getManagedOpenCodePreflight()).toBe(false);
  } finally {
    await server.close();
  }
});

it('a rejected CLI preflight never permits desktop bootstrap', async () => {
  const runtime = createRuntime({
    checkOpenCodeBinary: async () => {
      throw Object.assign(new Error('Unsupported CLI'), { code: 'OPENCODE_BINARY_INVALID' });
    },
  });
  await expect(runtime.startOpenCode()).rejects.toThrow('Unsupported CLI');
  expect(await runtime.getManagedOpenCodePreflight()).toBe(false);
  expect(spawnMock).not.toHaveBeenCalled();
});

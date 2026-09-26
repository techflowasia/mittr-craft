import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionGoalRuntime } from './runtime.js';

const SESSION_ID = 'ses_parent';
const CHILD_ID = 'ses_child';
const DIRECTORY = '/workspace';

const goal = {
  id: 'goal_1',
  objective: 'Finish the task',
  status: 'active',
  turnsUsed: 1,
  createdAt: 1,
  updatedAt: 1,
};

const session = {
  id: SESSION_ID,
  directory: DIRECTORY,
  metadata: { mittrcraft: { goal } },
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const requestPath = (input) => new URL(typeof input === 'string' ? input : input.url).pathname;

const startIdleTick = async (fetchImpl) => {
  const getSmallModelService = vi.fn();
  vi.stubGlobal('fetch', fetchImpl);
  const runtime = createSessionGoalRuntime({
    buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
    getSmallModelService,
    idleQuietMs: 10,
  });
  runtime.processPayload({
    type: 'session.status',
    properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
  });
  await vi.advanceTimersByTimeAsync(10);
  return { runtime, getSmallModelService };
};

describe('session goal live activity gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('waits for the next parent idle when the parent resumed during the quiet window', async () => {
    const paths = [];
    const { runtime, getSmallModelService } = await startIdleTick(vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'busy' } });
      throw new Error(`Unexpected request: ${pathname}`);
    }));

    expect(paths).toEqual([`/session/${SESSION_ID}`, '/session/status']);
    expect(getSmallModelService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(paths).toHaveLength(2);
    runtime.stop();
  });

  it('waits for the parent result cycle while a direct child is working', async () => {
    const paths = [];
    const { runtime, getSmallModelService } = await startIdleTick(vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ [CHILD_ID]: { type: 'busy' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([{ id: CHILD_ID, parentID: SESSION_ID }]);
      throw new Error(`Unexpected request: ${pathname}`);
    }));

    expect(paths).toEqual([
      `/session/${SESSION_ID}`,
      '/session/status',
      `/session/${SESSION_ID}/children`,
    ]);
    expect(getSmallModelService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(paths).toHaveLength(3);
    runtime.stop();
  });

  it('retries the quiet window when live status cannot be read', async () => {
    const paths = [];
    const { runtime, getSmallModelService } = await startIdleTick(vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ error: 'unavailable' }, 503);
      throw new Error(`Unexpected request: ${pathname}`);
    }));

    expect(paths).toEqual([`/session/${SESSION_ID}`, '/session/status']);
    expect(getSmallModelService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);
    expect(paths).toEqual([
      `/session/${SESSION_ID}`,
      '/session/status',
      `/session/${SESSION_ID}`,
      '/session/status',
    ]);
    runtime.stop();
  });

  it('derives the contract, judges it, and settles complete when every criterion is met', async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        return jsonResponse([{
          info: {
            id: 'msg_assistant',
            sessionID: SESSION_ID,
            role: 'assistant',
            providerID: 'provider',
            modelID: 'model',
            time: { created: 2, completed: 2 },
            tokens: { input: 1, output: 1, cache: { read: 0 } },
          },
          parts: [{ type: 'text', text: 'The task is verified complete.' }],
        }]);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async ({ responseSchema }) => ({
        text: responseSchema.properties.criteria
          ? '{"criteria":[{"text":"The task is finished","check":"judge","path":"","contains":"","command":""}]}'
          : '{"results":[{"id":"c1","verdict":"met","why":"shown"}]}',
        providerID: 'provider',
        modelID: 'model',
      })),
    };
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => service,
      idleQuietMs: 10,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(service.generateSmallModelText).toHaveBeenCalledTimes(2);
    const patch = requests.find((request) => request.pathname === `/session/${SESSION_ID}` && request.method === 'PATCH');
    expect(patch).toBeDefined();
    const writtenGoal = JSON.parse(patch.body).metadata.mittrcraft.goal;
    expect(writtenGoal).toMatchObject({
      status: 'complete',
      statusReason: 'verified by judge',
      evaluationProviderID: 'provider',
      evaluationModelID: 'model',
      criteria: [{ id: 'c1', text: 'The task is finished', status: 'met', by: 'model' }],
    });
    runtime.stop();
  });
});

const commandCriterion = { id: 'c1', text: 'Tests pass', check: { type: 'command', command: 'bun test' }, status: 'pending', reason: '', by: '' };

const runJudgedTick = async ({ goalOverrides = {}, parts }) => {
  const judgedSession = {
    ...session,
    metadata: { mittrcraft: { goal: { ...goal, criteria: [commandCriterion], ...goalOverrides } } },
  };
  const requests = [];
  const messages = [{
    info: {
      id: 'msg_assistant',
      sessionID: SESSION_ID,
      role: 'assistant',
      providerID: 'provider',
      modelID: 'model',
      agent: 'build',
      time: { created: 2, completed: 2 },
      tokens: { input: 1, output: 1, cache: { read: 0 } },
    },
    parts,
  }];
  vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
    const pathname = requestPath(input);
    requests.push({ pathname, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (pathname === `/session/${SESSION_ID}`) return jsonResponse(judgedSession);
    if (pathname === '/session/status') return jsonResponse({});
    if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
    if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse(messages);
    if (pathname === `/session/${SESSION_ID}/prompt_async`) return jsonResponse({});
    throw new Error(`Unexpected request: ${pathname}`);
  }));
  const getSmallModelService = vi.fn();
  const runtime = createSessionGoalRuntime({
    buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
    getSmallModelService,
    idleQuietMs: 10,
  });
  runtime.processPayload({
    type: 'session.status',
    properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
  });
  await vi.advanceTimersByTimeAsync(10);
  runtime.stop();
  return {
    getSmallModelService,
    patches: requests.filter((request) => request.method === 'PATCH').map((request) => request.body.metadata.mittrcraft.goal),
    prompts: requests.filter((request) => request.pathname.endsWith('/prompt_async')).map((request) => request.body),
  };
};

describe('mittr goal judge loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('sends a fabricated "done" back with what the record is missing', async () => {
    const { patches, prompts, getSmallModelService } = await runJudgedTick({
      parts: [{ type: 'text', text: 'Everything is done and all tests pass.' }],
    });

    expect(getSmallModelService).not.toHaveBeenCalled();
    expect(patches[0]).toMatchObject({
      status: 'active',
      turnsUsed: 2,
      note: 'Tests pass',
      criteria: [{ id: 'c1', status: 'missing', by: 'script' }],
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ model: { providerID: 'provider', modelID: 'model' }, agent: 'build' });
    const text = prompts[0].parts[0].text;
    expect(text).toContain('[NOT MET] Tests pass — `bun test` has not been run in this goal');
    expect(text).toContain('Only your tool calls count as evidence.');
  });

  it('settles complete from the tool record alone', async () => {
    const { patches, prompts } = await runJudgedTick({
      parts: [{ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'bun test' }, output: '3 pass', metadata: { exit: 0 } } }],
    });

    expect(prompts).toHaveLength(0);
    expect(patches[0]).toMatchObject({ status: 'complete', criteria: [{ status: 'met', by: 'script' }] });
  });

  it('stops as blocked when no criterion has been met for several rounds', async () => {
    const { patches, prompts } = await runJudgedTick({
      goalOverrides: { stallStreak: 4, bestMet: 0 },
      parts: [{ type: 'text', text: 'Still working.' }],
    });

    expect(prompts).toHaveLength(0);
    expect(patches[0]).toMatchObject({ status: 'blocked', statusReason: 'no progress on the remaining criteria', note: 'Tests pass' });
  });
});

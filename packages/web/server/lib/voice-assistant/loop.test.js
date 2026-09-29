import { afterEach, describe, expect, it, vi } from 'vitest';

import { MittrCraftControlError } from '../mittrcraft-control/error.js';
import { runVoiceTurn } from './loop.js';
import { buildVoiceTools } from './tools.js';

const SAID = 'เปิด example.com แล้วอ่านราคาแผนแรกให้ฟังหน่อย';
const PAGE = 'PAGE-TEXT-The first plan costs 990 baht';

const sse = (events) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
});

const toolCall = (id, name, args) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) });

const createDeps = ({ steps = [], execute, session = { accessToken: 'tok' }, settings = {}, describeSession } = {}) => {
  const queue = [...steps];
  const fetchImpl = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected step');
    return typeof next === 'function' ? next() : sse(next);
  });
  return {
    brokerBaseUrl: 'https://api.example/',
    ensureFreshSession: vi.fn(async () => session),
    fetchImpl,
    controlService: { execute: execute ?? vi.fn(async () => ({ ok: true })) },
    readSettings: vi.fn(async () => settings),
    buildContext: vi.fn(async () => 'Project: App'),
    describeSession: describeSession ?? vi.fn(async () => ({ found: true, id: 'ses_1', directory: '/repo', status: 'idle' })),
    buildTools: (current) => buildVoiceTools({ chromeAvailable: true, computerAvailable: true, settings: current }),
    chromePage: { note: vi.fn() },
    conversation: { pendingApprovalHost: null },
  };
};

const run = async (deps, overrides = {}) => {
  const events = [];
  await runVoiceTurn({
    said: SAID,
    history: [{ role: 'user', text: 'สวัสดี' }, { role: 'assistant', text: 'สวัสดีค่ะ' }],
    locale: 'th',
    directory: '/repo',
    sessionId: 'ses_1',
    emit: (event) => events.push(event),
    deps,
    ...overrides,
  });
  return events;
};

const stepBody = (deps, index) => JSON.parse(deps.fetchImpl.mock.calls[index][1].body);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runVoiceTurn', () => {
  it('runs a tool the model asked for and asks again with its result', async () => {
    const execute = vi.fn(async () => ({ url: 'https://example.com', title: 'Example' }));
    const deps = createDeps({
      execute,
      steps: [
        [{ type: 'text-delta', text: 'กำลังเปิด' }, toolCall('c1', 'mittrcraft_web', { action: 'chrome.open', url: 'https://example.com' }), { type: 'done' }],
        [{ type: 'text-delta', text: 'ราคา 990 บาท' }, { type: 'done' }],
      ],
    });
    const events = await run(deps);

    expect(events).toEqual([
      { type: 'text-delta', text: 'กำลังเปิด' },
      { type: 'action', kind: 'running', label: 'Open a page in Chrome' },
      { type: 'tool-result', id: 'c1', ok: true },
      { type: 'text-delta', text: 'ราคา 990 บาท' },
      { type: 'done' },
    ]);
    expect(execute).toHaveBeenCalledWith('chrome.open', { url: 'https://example.com' }, '/repo', expect.objectContaining({ signal: expect.any(AbortSignal), sessionId: 'voice' }));
    expect(deps.chromePage.note).toHaveBeenCalledWith('chrome.open', true);

    const [url, init] = deps.fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example/desktop/voice/step');
    expect(init.headers.Authorization).toBe('Bearer tok');
    const first = stepBody(deps, 0);
    expect(first).toMatchObject({ locale: 'th', context: 'Project: App', tools: buildVoiceTools({ chromeAvailable: true, computerAvailable: true }) });
    expect(first.messages).toEqual([
      { role: 'user', content: 'สวัสดี' },
      { role: 'assistant', content: 'สวัสดีค่ะ' },
      { role: 'user', content: SAID },
    ]);
    const second = stepBody(deps, 1);
    expect(second.messages.slice(3)).toEqual([
      { role: 'assistant', content: 'กำลังเปิด', toolCalls: [{ id: 'c1', name: 'mittrcraft_web', arguments: JSON.stringify({ action: 'chrome.open', url: 'https://example.com' }) }] },
      { role: 'tool', toolCallId: 'c1', name: 'mittrcraft_web', content: JSON.stringify({ url: 'https://example.com', title: 'Example' }) },
    ]);
  });

  it('accepts inputs nested in a parameters object, as the agent tool does', async () => {
    const execute = vi.fn(async () => ({}));
    const deps = createDeps({
      execute,
      steps: [
        [toolCall('c1', 'mittrcraft', { action: 'jira.get_issue', parameters: { key: 'MIT-42' } }), { type: 'done' }],
        [{ type: 'done' }],
      ],
    });
    await run(deps);
    expect(execute).toHaveBeenCalledWith('jira.get_issue', { key: 'MIT-42' }, '/repo', expect.anything());
  });

  it('turns a tool error into a tool result and carries on', async () => {
    const execute = vi.fn(async () => {
      throw new MittrCraftControlError('The user has not yet allowed using their Chrome sign-in on example.com', 403, { code: 'site_approval_required', host: 'example.com' });
    });
    const deps = createDeps({
      execute,
      steps: [
        [toolCall('c1', 'mittrcraft_web', { action: 'chrome.open', url: 'https://example.com' }), { type: 'done' }],
        [{ type: 'text-delta', text: 'ต้องอนุญาตก่อน' }, { type: 'done' }],
      ],
    });
    const events = await run(deps);
    expect(events).toContainEqual({ type: 'tool-result', id: 'c1', ok: false });
    expect(events.at(-1)).toEqual({ type: 'done' });
    const toolMessage = stepBody(deps, 1).messages.at(-1);
    expect(toolMessage.role).toBe('tool');
    expect(JSON.parse(toolMessage.content)).toMatchObject({
      error: 'The user has not yet allowed using their Chrome sign-in on example.com',
      reasonCode: 'site_approval_required',
    });
    expect(deps.chromePage.note).toHaveBeenCalledWith('chrome.open', false);
  });

  it('refuses an action the named tool does not offer', async () => {
    const execute = vi.fn();
    const deps = createDeps({
      execute,
      steps: [
        [toolCall('c1', 'mittrcraft', { action: 'session.stop', sessionId: 'ses_1' }), { type: 'done' }],
        [{ type: 'done' }],
      ],
    });
    const events = await run(deps);
    expect(execute).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: 'tool-result', id: 'c1', ok: false });
    expect(JSON.parse(stepBody(deps, 1).messages.at(-1).content).reasonCode).toBe('unsupported_action');
  });

  it('caps each tool result and never forwards image bytes', async () => {
    const execute = vi.fn(async () => ({ path: 'a.png', imageBase64: 'A'.repeat(50_000), imageMime: 'image/png', note: 'x'.repeat(30_000) }));
    const deps = createDeps({
      execute,
      steps: [
        [toolCall('c1', 'mittrcraft_web', { action: 'chrome.screenshot' }), { type: 'done' }],
        [{ type: 'done' }],
      ],
    });
    await run(deps);
    const content = stepBody(deps, 1).messages.at(-1).content;
    expect(content.length).toBeLessThanOrEqual(20_000);
    expect(content).not.toContain('AAAA');
  });

  it('stops at the step cap and says how far it got', async () => {
    const execute = vi.fn(async () => ({}));
    const step = () => sse([toolCall(`c${Math.random()}`, 'mittrcraft_web', { action: 'chrome.snapshot' }), { type: 'done' }]);
    const deps = createDeps({ execute, settings: { voiceStepCap: 2 }, steps: [step, step, step] });
    const events = await run(deps);
    expect(deps.fetchImpl).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    const closing = events.at(-2);
    expect(closing.type).toBe('text-delta');
    expect(closing.text).toContain('2');
    expect(closing.text).toContain('Read the Chrome page');
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('uses the default cap when the setting is missing or out of range', async () => {
    const step = () => sse([toolCall('c', 'mittrcraft', { action: 'projects.list' }), { type: 'done' }]);
    const deps = createDeps({ settings: { voiceStepCap: 99 }, steps: Array.from({ length: 10 }, () => step) });
    await run(deps);
    expect(deps.fetchImpl).toHaveBeenCalledTimes(8);
  });

  it('queues a prompt for a busy session instead of sending it', async () => {
    const execute = vi.fn(async () => ({}));
    const describeSession = vi.fn(async () => ({ found: true, id: 'ses_2', directory: '/repo/other', status: 'busy' }));
    const deps = createDeps({
      execute,
      describeSession,
      steps: [
        [toolCall('c1', 'mittrcraft', { action: 'session.send', sessionId: 'ses_2', prompt: 'add tests' }), { type: 'done' }],
        [{ type: 'text-delta', text: 'queued' }, { type: 'done' }],
      ],
    });
    const events = await run(deps);
    expect(execute).not.toHaveBeenCalled();
    expect(describeSession).toHaveBeenCalledWith('ses_2', '/repo');
    expect(events).toContainEqual({ type: 'queue', sessionId: 'ses_2', directory: '/repo/other', text: 'add tests' });
    expect(events).toContainEqual({ type: 'tool-result', id: 'c1', ok: true });
    expect(JSON.parse(stepBody(deps, 1).messages.at(-1).content)).toMatchObject({ queued: true, sessionId: 'ses_2' });
  });

  it('sends to an idle session', async () => {
    const execute = vi.fn(async () => ({ promptDispatched: true }));
    const deps = createDeps({
      execute,
      describeSession: vi.fn(async () => ({ found: true, id: 'ses_1', directory: '/repo', status: 'idle' })),
      steps: [
        [toolCall('c1', 'mittrcraft', { action: 'session.send', sessionId: 'ses_1', prompt: 'go' }), { type: 'done' }],
        [{ type: 'done' }],
      ],
    });
    await run(deps);
    expect(execute).toHaveBeenCalledWith('session.send', { sessionId: 'ses_1', prompt: 'go' }, '/repo', expect.anything());
  });

  it('does not send when it cannot tell whether the session is busy', async () => {
    const execute = vi.fn();
    const deps = createDeps({
      execute,
      describeSession: vi.fn(async () => ({ found: true, id: 'ses_1', directory: '/repo', status: 'unknown' })),
      steps: [
        [toolCall('c1', 'mittrcraft', { action: 'session.send', sessionId: 'ses_1', prompt: 'go' }), { type: 'done' }],
        [{ type: 'done' }],
      ],
    });
    const events = await run(deps);
    expect(execute).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: 'tool-result', id: 'c1', ok: false });
  });

  it('drops the result of a tool still running when the turn is aborted and takes no further step', async () => {
    const controller = new AbortController();
    let finish;
    const execute = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const deps = createDeps({
      execute,
      steps: [
        [toolCall('c1', 'mittrcraft_web', { action: 'chrome.do', goal: 'pick Bangkok' }), { type: 'done' }],
        [{ type: 'done' }],
      ],
    });
    const events = [];
    const turn = runVoiceTurn({ said: SAID, history: [], locale: 'th', emit: (event) => events.push(event), signal: controller.signal, deps });
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    controller.abort();
    finish({ done: true });
    await turn;
    expect(events).toEqual([{ type: 'action', kind: 'running', label: 'Do a task on the Chrome page' }]);
    expect(deps.fetchImpl).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][3].signal.aborted).toBe(true);
  });

  it('cancels the step request when the turn is aborted', async () => {
    const controller = new AbortController();
    const deps = createDeps();
    deps.fetchImpl = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const events = [];
    const turn = runVoiceTurn({ said: SAID, history: [], locale: 'en', emit: (event) => events.push(event), signal: controller.signal, deps });
    await vi.waitFor(() => expect(deps.fetchImpl).toHaveBeenCalled());
    controller.abort();
    await turn;
    expect(events).toEqual([]);
  });

  it('reports not signed in before any call', async () => {
    const deps = createDeps({ session: null });
    const events = await run(deps);
    expect(events).toEqual([{ type: 'error', code: 'not_signed_in' }]);
    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.buildContext).not.toHaveBeenCalled();
  });

  it('passes the platform’s error through and ends the turn', async () => {
    const deps = createDeps({ steps: [[{ type: 'error', code: 'not_configured' }]] });
    const events = await run(deps);
    expect(events).toEqual([{ type: 'error', code: 'not_configured' }]);
  });

  it('maps a rejected desktop session and a failed request to error codes', async () => {
    const forbidden = createDeps({ steps: [() => new Response(JSON.stringify({ message: 'desktop_session_required' }), { status: 403 })] });
    expect(await run(forbidden)).toEqual([{ type: 'error', code: 'not_signed_in' }]);
    const broken = createDeps({ steps: [() => new Response('nope', { status: 502 })] });
    expect(await run(broken)).toEqual([{ type: 'error', code: 'upstream_failed' }]);
    const bad = createDeps({ steps: [() => new Response(JSON.stringify({ code: 'bad_request' }), { status: 400 })] });
    expect(await run(bad)).toEqual([{ type: 'error', code: 'bad_request' }]);
  });

  it('keeps the conversation inside the platform’s limits by dropping the oldest history', async () => {
    const deps = createDeps({ steps: [[{ type: 'done' }]] });
    const history = Array.from({ length: 80 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `line ${index} ${'x'.repeat(4000)}` }));
    await run(deps, { history });
    const { messages } = stepBody(deps, 0);
    expect(messages.length).toBeLessThanOrEqual(60);
    expect(messages.reduce((total, message) => total + message.content.length, 0)).toBeLessThanOrEqual(200_000);
    expect(messages.at(-1)).toEqual({ role: 'user', content: SAID });
    expect(messages.at(-2).content).toContain('line 79');
  });

  it('never logs what was said, tool arguments or results', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const execute = vi.fn(async (action) => {
      if (action === 'chrome.read') return { text: PAGE };
      throw new Error(`failed on ${PAGE}`);
    });
    const deps = createDeps({
      execute,
      steps: [
        [toolCall('c1', 'mittrcraft_web', { action: 'chrome.read', secretArg: 'ARG-SECRET' }), toolCall('c2', 'mittrcraft_web', { action: 'chrome.click', ref: '@e1', value: 'ARG-SECRET' }), { type: 'done' }],
        () => new Response('boom', { status: 500 }),
      ],
    });
    await run(deps);
    const logged = spies.flatMap((spy) => spy.mock.calls).map((call) => call.map((part) => (part instanceof Error ? part.message : String(part))).join(' ')).join('\n');
    expect(logged).not.toContain(SAID);
    expect(logged).not.toContain('ARG-SECRET');
    expect(logged).not.toContain(PAGE);
  });

  it('closes a capped turn in the language that was spoken, not the UI locale', async () => {
    const step = () => sse([toolCall('c', 'mittrcraft_web', { action: 'chrome.snapshot' }), { type: 'done' }]);
    const deps = createDeps({ settings: { voiceStepCap: 1 }, steps: [step] });
    const events = await run(deps, { said: 'open example.com', locale: 'th' });
    expect(events.at(-2).text).toMatch(/^I stopped after 1 steps/);
    const thai = await run(createDeps({ settings: { voiceStepCap: 1 }, steps: [step] }), { said: 'เปิดเว็บ', locale: 'en' });
    expect(thai.at(-2).text).toMatch(/^หยุดไว้ก่อน/);
  });

  it('uses a freshly refreshed token on every step', async () => {
    const deps = createDeps({
      steps: [
        [toolCall('c1', 'mittrcraft', { action: 'projects.list' }), { type: 'done' }],
        [{ type: 'done' }],
      ],
    });
    deps.ensureFreshSession = vi.fn()
      .mockResolvedValueOnce({ accessToken: 'tok-1' })
      .mockResolvedValueOnce({ accessToken: 'tok-2' });
    await run(deps);
    expect(deps.fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer tok-1');
    expect(deps.fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer tok-2');
  });

  it('ends the turn as not signed in when the session is lost between steps', async () => {
    const deps = createDeps({
      steps: [
        [toolCall('c1', 'mittrcraft', { action: 'projects.list' }), { type: 'done' }],
        [{ type: 'done' }],
      ],
    });
    deps.ensureFreshSession = vi.fn().mockResolvedValueOnce({ accessToken: 'tok-1' }).mockResolvedValueOnce(null);
    const events = await run(deps);
    expect(events.at(-1)).toEqual({ type: 'error', code: 'not_signed_in' });
    expect(deps.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('offers and runs only the actions whose agent tool switch is on', async () => {
    const execute = vi.fn(async () => ({}));
    const deps = createDeps({
      execute,
      settings: { agentChromeToolEnabled: false, agentControlToolEnabled: false },
      steps: [
        [
          toolCall('c1', 'mittrcraft_web', { action: 'chrome.open', url: 'https://example.com' }),
          toolCall('c2', 'mittrcraft', { action: 'projects.list' }),
          toolCall('c3', 'mittrcraft_web', { action: 'browser.open', url: 'http://localhost:3000' }),
          { type: 'done' },
        ],
        [{ type: 'done' }],
      ],
    });
    const events = await run(deps);
    const { tools } = stepBody(deps, 0);
    expect(tools.map(({ name }) => name)).toEqual(['mittrcraft_web']);
    expect(tools[0].parameters.properties.action.enum.some((action) => action.startsWith('chrome.'))).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toBe('browser.open');
    expect(events).toContainEqual({ type: 'tool-result', id: 'c1', ok: false });
    expect(events).toContainEqual({ type: 'tool-result', id: 'c2', ok: false });
  });

  it('runs at most 20 calls per step and keeps the turn within the platform limits', async () => {
    const execute = vi.fn(async () => ({ text: 'r'.repeat(19_000) }));
    const calls = Array.from({ length: 25 }, (_, index) => toolCall(`c${index}`, 'mittrcraft', { action: 'projects.list', note: 'a'.repeat(2000) }));
    const deps = createDeps({ execute, steps: [[...calls, { type: 'done' }], [{ type: 'done' }]] });
    const history = Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `h${index} ${'x'.repeat(5000)}` }));
    const events = await run(deps, { history });
    expect(execute).toHaveBeenCalledTimes(20);
    const second = stepBody(deps, 1);
    const size = second.messages.reduce((total, message) => total + message.content.length
      + (message.toolCalls ?? []).reduce((sum, call) => sum + call.arguments.length, 0), 0);
    expect(size).toBeLessThanOrEqual(200_000);
    expect(second.messages.length).toBeLessThanOrEqual(60);
    const toolMessages = second.messages.filter((message) => message.role === 'tool');
    expect(toolMessages).toHaveLength(25);
    expect(toolMessages[0].content).toBe('[result omitted]');
    expect(toolMessages[19].content).toContain('rrrr');
    for (const message of toolMessages.slice(20)) expect(JSON.parse(message.content).reasonCode).toBe('too_many_calls');
    expect(events.filter((event) => event.type === 'tool-result' && event.ok === false)).toHaveLength(5);
    expect(second.messages.some((message) => message.content.startsWith('h0 '))).toBe(true);
  });

  it('counts tool call arguments toward the size limit', async () => {
    const deps = createDeps({
      steps: [
        [toolCall('c1', 'mittrcraft', { action: 'projects.list', note: 'n'.repeat(30_000) }), { type: 'done' }],
        [{ type: 'done' }],
      ],
    });
    const history = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `h${index} ${'x'.repeat(4500)}` }));
    await run(deps, { history });
    const second = stepBody(deps, 1);
    const size = second.messages.reduce((total, message) => total + message.content.length
      + (message.toolCalls ?? []).reduce((sum, call) => sum + call.arguments.length, 0), 0);
    expect(size).toBeLessThanOrEqual(200_000);
  });

  it('ends a tool that runs past its deadline as a timeout result and carries on', async () => {
    const execute = vi.fn((_action, _input, _directory, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const deps = createDeps({
      execute,
      steps: [
        [toolCall('c1', 'mittrcraft_web', { action: 'chrome.do', goal: 'x' }), { type: 'done' }],
        [{ type: 'done' }],
      ],
    });
    deps.toolTimeoutMs = 20;
    const events = await run(deps);
    expect(JSON.parse(stepBody(deps, 1).messages.at(-1).content).reasonCode).toBe('tool_timeout');
    expect(execute.mock.calls[0][3].signal.aborted).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('offers no wait or timeout to the voice and strips them from calls', async () => {
    const execute = vi.fn(async () => ({}));
    const deps = createDeps({
      execute,
      steps: [
        [toolCall('c1', 'mittrcraft', { action: 'session.messages', sessionId: 'ses_1', wait: true, timeout: 86400 }), { type: 'done' }],
        [{ type: 'done' }],
      ],
    });
    await run(deps);
    const control = stepBody(deps, 0).tools.find(({ name }) => name === 'mittrcraft');
    expect(control.parameters.properties.wait).toBeUndefined();
    expect(control.parameters.properties.timeout).toBeUndefined();
    expect(execute.mock.calls[0][1]).toEqual({ sessionId: 'ses_1' });
  });

  it.each([
    ['in the same step', [[toolCall('r', 'mittrcraft_voice', { action: 'session.read_reply', sessionId: 'ses_1' }), toolCall('s', 'mittrcraft_voice', { action: 'session.stop', sessionId: 'ses_1' }), { type: 'done' }], [{ type: 'done' }]]],
    ['in an earlier step', [[toolCall('r', 'mittrcraft_web', { action: 'chrome.read' }), { type: 'done' }], [toolCall('s', 'mittrcraft_voice', { action: 'session.stop', sessionId: 'ses_1' }), { type: 'done' }], [{ type: 'done' }]]],
  ])('refuses session.stop after a read %s', async (_label, steps) => {
    const execute = vi.fn(async () => ({}));
    const deps = createDeps({ execute, steps });
    const events = await run(deps);
    expect(execute.mock.calls.map(([action]) => action)).not.toContain('session.stop');
    expect(events).toContainEqual({ type: 'tool-result', id: 's', ok: false });
    const last = stepBody(deps, deps.fetchImpl.mock.calls.length - 1).messages.at(-1);
    expect(JSON.parse(last.content).reasonCode).toBe('refused_after_read');
  });

  it('runs session.stop when nothing was read in the turn', async () => {
    const execute = vi.fn(async () => ({ stopped: true }));
    const deps = createDeps({
      execute,
      steps: [[toolCall('s', 'mittrcraft_voice', { action: 'session.stop', sessionId: 'ses_1' }), { type: 'done' }], [{ type: 'done' }]],
    });
    await run(deps);
    expect(execute).toHaveBeenCalledWith('session.stop', { sessionId: 'ses_1' }, '/repo', expect.anything());
  });

  it('records the host of a site approval request and tells the model to ask the person', async () => {
    const execute = vi.fn(async () => {
      throw new MittrCraftControlError('The user has not yet allowed using their Chrome sign-in on example.com', 403, { code: 'site_approval_required', host: 'example.com' });
    });
    const deps = createDeps({
      execute,
      steps: [[toolCall('c1', 'mittrcraft_web', { action: 'chrome.open', url: 'https://example.com' }), { type: 'done' }], [{ type: 'done' }]],
    });
    await run(deps);
    const result = JSON.parse(stepBody(deps, 1).messages.at(-1).content);
    expect(result).toMatchObject({ reasonCode: 'site_approval_required', host: 'example.com' });
    expect(result.ask).toContain('allow example.com for this conversation?');
    expect(result.ask).toContain('chrome.allow_site');
    expect(deps.conversation.pendingApprovalHost).toBe('example.com');
  });

  it('allows the requested site in a later turn after a spoken yes', async () => {
    const execute = vi.fn(async () => ({ allowed: true, host: 'example.com', scope: 'conversation' }));
    const deps = createDeps({
      execute,
      steps: [[toolCall('a', 'mittrcraft_voice', { action: 'chrome.allow_site', host: 'Example.com' }), { type: 'done' }], [{ type: 'done' }]],
    });
    deps.conversation.pendingApprovalHost = 'example.com';
    const events = await run(deps, { said: 'ใช่ อนุญาต' });
    expect(execute).toHaveBeenCalledWith('chrome.allow_site', { host: 'Example.com' }, '/repo', expect.objectContaining({ sessionId: 'voice' }));
    expect(events).toContainEqual({ type: 'tool-result', id: 'a', ok: true });
    expect(deps.conversation.pendingApprovalHost).toBeNull();
  });

  it.each([
    ['no site was asked about', null, [toolCall('a', 'mittrcraft_voice', { action: 'chrome.allow_site', host: 'example.com' })], 'not_requested'],
    ['a different site was asked about', 'example.com', [toolCall('a', 'mittrcraft_voice', { action: 'chrome.allow_site', host: 'evil.example' })], 'not_requested'],
    ['something was read first', 'example.com', [toolCall('r', 'mittrcraft_web', { action: 'chrome.snapshot' }), toolCall('a', 'mittrcraft_voice', { action: 'chrome.allow_site', host: 'example.com' })], 'refused_after_read'],
  ])('refuses chrome.allow_site when %s', async (_label, pending, calls, reasonCode) => {
    const execute = vi.fn(async () => ({}));
    const deps = createDeps({ execute, steps: [[...calls, { type: 'done' }], [{ type: 'done' }]] });
    deps.conversation.pendingApprovalHost = pending;
    const events = await run(deps);
    expect(execute.mock.calls.map(([action]) => action)).not.toContain('chrome.allow_site');
    expect(events).toContainEqual({ type: 'tool-result', id: 'a', ok: false });
    expect(JSON.parse(stepBody(deps, 1).messages.at(-1).content).reasonCode).toBe(reasonCode);
  });

  it('records a Chrome page that opened even when the turn was aborted meanwhile', async () => {
    const controller = new AbortController();
    let finish;
    const execute = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const deps = createDeps({ execute, steps: [[toolCall('c1', 'mittrcraft_web', { action: 'chrome.open', url: 'https://example.com' }), { type: 'done' }]] });
    const turn = runVoiceTurn({ said: SAID, history: [], locale: 'th', emit: () => {}, signal: controller.signal, deps });
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    controller.abort();
    await turn;
    finish({ url: 'https://example.com' });
    await vi.waitFor(() => expect(deps.chromePage.note).toHaveBeenCalledWith('chrome.open', true));
  });

  it.each([
    ['session.send', 'mittrcraft', { action: 'session.send', sessionId: 'ses_1', prompt: 'go' }],
    ['session.create', 'mittrcraft', { action: 'session.create', prompt: 'go' }],
    ['session.fork', 'mittrcraft', { action: 'session.fork', sessionId: 'ses_1' }],
    ['schedule.create', 'mittrcraft', { action: 'schedule.create', name: 'n', prompt: 'p', model: 'a/b', daily: '09:00' }],
    ['schedule.run', 'mittrcraft', { action: 'schedule.run', taskId: 't' }],
    ['schedule.delete', 'mittrcraft', { action: 'schedule.delete', taskId: 't' }],
    ['schedule.toggle', 'mittrcraft', { action: 'schedule.toggle', taskId: 't', disabled: true }],
  ])('refuses %s after a read earlier in the same step', async (action, tool, args) => {
    const execute = vi.fn(async () => ({}));
    const deps = createDeps({
      execute,
      steps: [[toolCall('r', 'mittrcraft', { action: 'session.status', sessionId: 'ses_1' }), toolCall('w', tool, args), { type: 'done' }], [{ type: 'done' }]],
    });
    await run(deps);
    expect(execute.mock.calls.map(([called]) => called)).toEqual(['session.status']);
    expect(JSON.parse(stepBody(deps, 1).messages.at(-1).content).reasonCode).toBe('refused_after_read');
  });

  it.each([
    'session.list', 'chrome.screenshot', 'chrome.do', 'browser.inspect', 'browser.capture', 'computer.screenshot',
  ])('treats %s as a read', async (readAction) => {
    const execute = vi.fn(async () => ({}));
    const tool = readAction.startsWith('session.') ? 'mittrcraft' : 'mittrcraft_web';
    const deps = createDeps({
      execute,
      steps: [[toolCall('r', tool, { action: readAction, goal: 'g' }), toolCall('w', 'mittrcraft', { action: 'schedule.run', taskId: 't' }), { type: 'done' }], [{ type: 'done' }]],
    });
    await run(deps);
    expect(execute.mock.calls.map(([called]) => called)).toEqual([readAction]);
  });

  it('still lets the person act on the page after reading it', async () => {
    const execute = vi.fn(async () => ({}));
    const deps = createDeps({
      execute,
      steps: [[toolCall('r', 'mittrcraft_web', { action: 'chrome.snapshot' }), toolCall('c', 'mittrcraft_web', { action: 'chrome.click', ref: '@e1' }), { type: 'done' }], [{ type: 'done' }]],
    });
    await run(deps);
    expect(execute.mock.calls.map(([called]) => called)).toEqual(['chrome.snapshot', 'chrome.click']);
  });

  it('refuses session.stop until the assistant has spoken before the person’s last words', async () => {
    const execute = vi.fn(async () => ({}));
    const deps = createDeps({
      execute,
      steps: [[toolCall('s', 'mittrcraft_voice', { action: 'session.stop', sessionId: 'ses_1' }), { type: 'done' }], [{ type: 'done' }]],
    });
    await run(deps, { history: [{ role: 'user', text: 'hi' }] });
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(stepBody(deps, 1).messages.at(-1).content).reasonCode).toBe('confirm_first');
  });

  it('matches the action exactly as the top level names it', async () => {
    const execute = vi.fn(async () => ({}));
    const deps = createDeps({
      execute,
      steps: [[
        toolCall('a', 'mittrcraft_voice', { action: ' session.stop', sessionId: 'ses_1' }),
        toolCall('b', 'mittrcraft_voice', { action: 'Session.Stop', sessionId: 'ses_1' }),
        toolCall('c', 'mittrcraft_voice', { parameters: { action: 'session.stop', sessionId: 'ses_1' } }),
        toolCall('d', 'mittrcraft_web', { action: 'chrome.click', ref: '@e1', parameters: { action: 'session.stop' } }),
        { type: 'done' },
      ], [{ type: 'done' }]],
    });
    await run(deps);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('chrome.click', { ref: '@e1' }, '/repo', expect.anything());
    const reasons = stepBody(deps, 1).messages.filter((message) => message.role === 'tool').slice(0, 3).map((message) => JSON.parse(message.content).reasonCode);
    expect(reasons).toEqual(['unsupported_action', 'unsupported_action', 'unsupported_action']);
  });

  it('only ever sends what the person said as user messages and pairs every tool message with its call', async () => {
    const calls = Array.from({ length: 22 }, (_, index) => toolCall(`c${index}`, 'mittrcraft', { action: 'projects.list' }));
    const deps = createDeps({
      describeSession: vi.fn(async () => ({ found: true, id: 'ses_1', directory: '/repo', status: 'busy' })),
      settings: { voiceStepCap: 3 },
      steps: [
        [...calls, { type: 'done' }],
        [toolCall('q', 'mittrcraft', { action: 'session.send', sessionId: 'ses_1', prompt: 'later' }), { type: 'done' }],
        [toolCall('x', 'mittrcraft', { action: 'projects.list' }), { type: 'done' }],
      ],
    });
    await run(deps);
    for (let index = 0; index < deps.fetchImpl.mock.calls.length; index += 1) {
      const { messages } = stepBody(deps, index);
      expect(messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual(['สวัสดี', SAID]);
      messages.forEach((message, position) => {
        if (message.role !== 'tool') return;
        const owner = messages.slice(0, position).reverse().find((candidate) => candidate.role !== 'tool');
        expect(owner.role).toBe('assistant');
        expect(owner.toolCalls.map(({ id }) => id)).toContain(message.toolCallId);
      });
    }
  });
});

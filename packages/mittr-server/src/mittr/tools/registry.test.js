import assert from 'node:assert/strict';
import test from 'node:test';

import { MITTR_TOOLS, MittrToolError, NO_TOOL_NAME, createMittrActionRegistry } from './registry.js';

const UPSTREAM_DEFINITIONS = {
  control: [
    { action: 'session.list', title: 'List sessions', description: 'List sessions' },
    { action: 'session.create', title: 'Create a session', description: 'Create a session' },
  ],
  web: [
    { action: 'browser.open', title: 'Open a page in the browser panel', description: 'Open url' },
  ],
};

const UPSTREAM_ALL = ['session.list', 'session.create', 'schedule.status', 'memory.save', 'notify.send', 'browser.open'];

const recordingLogger = () => {
  const warnings = [];
  return { warnings, log: () => {}, warn: (...args) => warnings.push(args.join(' ')) };
};

const fakeControl = (answer = async () => ({ sessions: [] })) => {
  const calls = [];
  return {
    calls,
    execute: async (...args) => {
      calls.push(args);
      return answer(...args);
    },
    resolveSessionDirectory: async () => null,
    definitions: () => UPSTREAM_DEFINITIONS,
    all: UPSTREAM_ALL,
  };
};

const CHROME = 'mittrcraft_chrome';
const COMPUTER = 'mittrcraft_computer';

const setUp = ({ control = fakeControl(), chromeAvailable = () => true, logger = recordingLogger() } = {}) => {
  const registry = createMittrActionRegistry({ control, logger });
  const runs = [];
  const run = (name) => async (input, ctx) => {
    runs.push({ name, input, ctx });
    return { ran: name };
  };
  registry.defineTool({ name: CHROME, description: 'Drive Chrome', parameters: { type: 'object' } });
  registry.defineTool({ name: COMPUTER, description: 'Drive the desktop', parameters: { type: 'object' } });
  registry.register({ action: 'chrome.open', tool: CHROME, title: 'Open a page in Chrome', description: 'Open url', effect: 'change', available: chromeAvailable, execute: run('chrome.open') });
  registry.register({ action: 'chrome.read', tool: CHROME, title: 'Read the Chrome page', description: 'Read the page', effect: 'read', available: chromeAvailable, execute: run('chrome.read') });
  registry.register({ action: 'computer.screenshot', tool: COMPUTER, title: 'Look at the screen', description: 'Screenshot', effect: 'read', execute: run('computer.screenshot') });
  registry.register({ action: 'computer.click', tool: COMPUTER, title: 'Click on the screen', description: 'Click', effect: 'change', execute: run('computer.click') });
  return { registry, control, runs, logger };
};

const refusal = (statusCode, message) => (error) => {
  assert.ok(error instanceof MittrToolError, `expected a MittrToolError, got ${error}`);
  assert.equal(error.statusCode, statusCode);
  if (message) assert.equal(error.message, message);
  return true;
};

test('a Mittr action runs its own execute with the context', async () => {
  const { registry, control, runs } = setUp();
  const signal = new AbortController().signal;
  const ctx = { directory: '/p', sessionId: 's1', signal, approvalAnswered: true, headed: false, surface: 'agent', tool: CHROME };

  assert.deepEqual(await registry.execute('chrome.open', { url: 'http://a.test' }, ctx), { ran: 'chrome.open' });

  assert.deepEqual(runs, [{ name: 'chrome.open', input: { url: 'http://a.test' }, ctx }]);
  assert.equal(control.calls.length, 0);
});

test('an upstream action goes to the control service with the directory and calling session', async () => {
  const { registry, control } = setUp();
  const signal = new AbortController().signal;

  for (const surface of ['voice', 'http']) {
    assert.deepEqual(await registry.execute('session.list', {}, { directory: '/p', sessionId: 's1', signal, surface }), { sessions: [] });
  }

  assert.deepEqual(control.calls, [
    ['session.list', {}, '/p', { contextSessionId: 's1', signal }],
    ['session.list', {}, '/p', { contextSessionId: 's1', signal }],
  ]);
});

test('open from the chrome tool resolves to chrome.open and from the computer tool it lists that tool\'s actions', () => {
  const { registry } = setUp();

  assert.deepEqual(registry.resolve('open', CHROME), { action: 'chrome.open' });
  assert.deepEqual(registry.resolve(' chrome.read ', CHROME), { action: 'chrome.read' });
  assert.deepEqual(registry.resolve('open', COMPUTER), {
    error: 'Unknown action "open" for mittrcraft_computer; it has: computer.screenshot, computer.click',
  });
  assert.deepEqual(registry.resolve('chrome.open', COMPUTER), {
    error: 'Unknown action "chrome.open" for mittrcraft_computer; it has: computer.screenshot, computer.click',
  });
});

test('chrome tool asking session.create is refused', async () => {
  const { registry, control } = setUp();

  for (const requested of ['session.create', 'create', 'browser.open']) {
    assert.deepEqual(registry.resolve(requested, CHROME), {
      error: `Unknown action "${requested}" for mittrcraft_chrome; it has: chrome.open, chrome.read`,
    });
  }
  await assert.rejects(
    registry.execute('session.create', {}, { directory: '/p', surface: 'agent', tool: CHROME }),
    refusal(400, 'Unknown action "session.create" for mittrcraft_chrome; it has: chrome.open, chrome.read'),
  );
  await assert.rejects(
    registry.execute('computer.click', {}, { directory: '/p', surface: 'agent', tool: CHROME }),
    refusal(400, 'Unknown action "computer.click" for mittrcraft_chrome; it has: chrome.open, chrome.read'),
  );
  assert.equal(control.calls.length, 0);
});

test('an unavailable action answers 503 and runs nothing', async () => {
  const { registry, control, runs } = setUp({ chromeAvailable: () => false });

  for (const surface of ['agent', 'voice', 'http']) {
    await assert.rejects(
      registry.execute('chrome.open', {}, { surface, tool: CHROME }),
      refusal(503, 'Open a page in Chrome is not available in this install'),
    );
  }
  assert.deepEqual(runs, []);
  assert.equal(control.calls.length, 0);
});

test('a voice-only action is refused for agents and http', async () => {
  const { registry, runs } = setUp();
  registry.register({ action: 'session.stop', tool: CHROME, title: 'Stop the answer', description: 'Stop', effect: 'change', voiceOnly: true, execute: async () => ({ stopped: true }) });

  await assert.rejects(registry.execute('session.stop', {}, { surface: 'agent', tool: CHROME }), refusal(400));
  await assert.rejects(registry.execute('session.stop', {}, { surface: 'http' }), refusal(400));
  assert.deepEqual(await registry.execute('session.stop', {}, { surface: 'voice' }), { stopped: true });
  assert.deepEqual(runs, []);

  assert.equal(registry.resolve('stop', CHROME).error, 'Unknown action "stop" for mittrcraft_chrome; it has: chrome.open, chrome.read');
  assert.deepEqual(registry.definitions({ tool: CHROME }).map(({ action }) => action), ['chrome.open', 'chrome.read']);
  assert.deepEqual(registry.definitions({ tool: CHROME, includeVoiceOnly: true }).at(-1), {
    action: 'session.stop', tool: CHROME, title: 'Stop the answer', description: 'Stop', effect: 'change', voiceOnly: true, available: true,
  });
});

test('a tool with only unavailable actions is not listed', () => {
  let offered = false;
  const { registry } = setUp({ chromeAvailable: () => offered });
  registry.defineTool({ name: 'mittrcraft_voice', description: 'Voice only', parameters: { type: 'object' } });
  registry.register({ action: 'voice.hush', tool: 'mittrcraft_voice', title: 'Hush', description: 'Hush', effect: 'change', voiceOnly: true, execute: async () => ({}) });

  assert.deepEqual(registry.tools().map(({ name }) => name), [COMPUTER]);

  offered = true;
  const tools = registry.tools();
  assert.deepEqual(tools.map(({ name }) => name), [CHROME, COMPUTER]);
  assert.deepEqual(tools[0], {
    name: CHROME,
    description: 'Drive Chrome',
    parameters: { type: 'object' },
    definitions: [
      { action: 'chrome.open', title: 'Open a page in Chrome', description: 'Open url' },
      { action: 'chrome.read', title: 'Read the Chrome page', description: 'Read the page' },
    ],
  });
});

test('definitions and has cover Mittr actions only', () => {
  const { registry } = setUp();

  assert.equal(registry.has('chrome.open'), true);
  assert.equal(registry.has('session.list'), false);
  assert.deepEqual(registry.definitions().map(({ action }) => action), ['chrome.open', 'chrome.read', 'computer.screenshot', 'computer.click']);
  assert.deepEqual(registry.definitions({ tool: COMPUTER })[0], {
    action: 'computer.screenshot', tool: COMPUTER, title: 'Look at the screen', description: 'Screenshot', effect: 'read', voiceOnly: false, available: true,
  });
});

test('each definition says whether this install can run it now', () => {
  let offered = false;
  const { registry } = setUp({ chromeAvailable: () => offered });

  assert.deepEqual(registry.definitions().map(({ action, available }) => [action, available]), [
    ['chrome.open', false], ['chrome.read', false], ['computer.screenshot', true], ['computer.click', true],
  ]);
  offered = true;
  assert.deepEqual(registry.definitions({ tool: CHROME }).map(({ available }) => available), [true, true]);
});

test('an available() that throws reads as unavailable, logs one line and leaves the other tools listed', async () => {
  const { registry, runs, logger } = setUp({ chromeAvailable: () => { throw new Error('secret detail'); } });

  assert.deepEqual(registry.tools().map(({ name }) => name), [COMPUTER]);
  assert.deepEqual(logger.warnings, [
    '[mittr] chrome.open could not tell whether it is available; treated as unavailable',
    '[mittr] chrome.read could not tell whether it is available; treated as unavailable',
  ]);
  assert.equal(registry.definitions({ tool: CHROME })[0].available, false);
  await assert.rejects(registry.execute('chrome.open', {}, { surface: 'voice' }), refusal(503));
  assert.deepEqual(runs, []);
  assert.ok(logger.warnings.every((line) => !line.includes('secret detail')));
});

test('an agent call with no tool name is a wiring error, not a model mistake', async () => {
  const { registry, control, runs } = setUp();

  for (const tool of [undefined, '']) {
    await assert.rejects(registry.execute('chrome.open', {}, { surface: 'agent', tool }), refusal(500, NO_TOOL_NAME));
  }
  assert.equal(NO_TOOL_NAME, 'MittrCraft tool call without a tool name');
  assert.deepEqual(runs, []);
  assert.equal(control.calls.length, 0);
});

test('an action registered twice, under an unknown tool or with an upstream name throws', () => {
  const { registry } = setUp();
  const entry = { tool: CHROME, title: 'T', description: 'D', effect: 'read', execute: async () => ({}) };

  assert.throws(() => registry.register({ ...entry, action: 'chrome.open' }), /chrome\.open is already registered/);
  assert.throws(() => registry.register({ ...entry, action: 'chrome.x', tool: 'mittrcraft_nothing' }), /mittrcraft_nothing is not a defined tool/);
  assert.throws(() => registry.register({ ...entry, action: 'chrome.x', effect: 'write' }), /effect/);
  assert.throws(() => registry.register({ ...entry, action: 'session.create' }), /session\.create is an upstream action/);
  assert.throws(() => registry.register({ ...entry, action: 'browser.open' }), /browser\.open is an upstream action/);
  assert.throws(() => registry.register({ ...entry, action: 'memory.save' }), /memory\.save is an upstream action/);
  assert.throws(() => registry.register({ ...entry, action: 'schedule.status' }), /schedule\.status is an upstream action/);
  assert.throws(() => registry.register({ ...entry, action: 'notify.send' }), /notify\.send is an upstream action/);
  assert.throws(() => registry.defineTool({ name: CHROME, description: 'again', parameters: {} }), /mittrcraft_chrome is already defined/);
  assert.equal(registry.has('session.create'), false);
  assert.equal(registry.has('memory.save'), false);
});

test('register takes only a lowercase dot-separated name and functions', () => {
  const { registry } = setUp();
  const entry = { tool: CHROME, title: 'T', description: 'D', effect: 'read', execute: async () => ({}) };

  for (const action of ['open', 'Chrome.open', 'chrome.Open', 'chrome open', ' chrome.open2', 'chrome.', '.open', 'chrome..open', '', undefined]) {
    assert.throws(() => registry.register({ ...entry, action }), /is not a lowercase, dot-separated action name/, `accepted ${JSON.stringify(action)}`);
  }
  assert.throws(() => registry.register({ ...entry, action: 'chrome.x', execute: 'run' }), /chrome\.x has no execute function/);
  assert.throws(() => registry.register({ ...entry, action: 'chrome.x', execute: undefined }), /chrome\.x has no execute function/);
  assert.throws(() => registry.register({ ...entry, action: 'chrome.x', available: true }), /chrome\.x has an available that is not a function/);
  assert.throws(() => registry.register({ ...entry, action: 'chrome.x', available: null }), /chrome\.x has an available that is not a function/);
  registry.register({ ...entry, action: 'chrome.tab_list', available: undefined });
  registry.register({ ...entry, action: 'chrome.page.read-all' });
  assert.deepEqual(registry.resolve('tab_list', CHROME), { action: 'chrome.tab_list' });
  assert.deepEqual(registry.resolve('page.read-all', CHROME), { action: 'chrome.page.read-all' });
});

test('an unknown surface is refused', async () => {
  const { registry, control, runs } = setUp();

  await assert.rejects(registry.execute('chrome.open', {}, { tool: CHROME }), refusal(400));
  await assert.rejects(registry.execute('session.list', {}, { surface: 'cli' }), refusal(400));
  assert.deepEqual(runs, []);
  assert.equal(control.calls.length, 0);
});

test('MittrToolError carries its status and extra fields', () => {
  const error = new MittrToolError('x', 403, { code: 'site_approval_required', host: 'a.test' });
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'MittrToolError');
  assert.equal(error.message, 'x');
  assert.equal(error.statusCode, 403);
  assert.equal(error.code, 'site_approval_required');
  assert.equal(error.host, 'a.test');
  assert.equal(new MittrToolError('y').statusCode, 500);
});

test('a chrome or computer action over http runs only for a request from this machine', async () => {
  const { registry, runs } = setUp();
  registry.defineTool({ name: 'mittrcraft_work', description: 'Cards', parameters: { type: 'object' } });
  registry.register({ action: 'jira.get_issue', tool: 'mittrcraft_work', title: 'Read a Jira issue', description: 'Read', effect: 'read', execute: async () => ({ read: true }) });

  for (const scope of [undefined, {}, { local: false }, { local: 'true' }]) {
    await assert.rejects(registry.execute('chrome.open', {}, { surface: 'http', scope }), refusal(403, 'Open a page in Chrome can only be used from this machine'), JSON.stringify(scope));
    await assert.rejects(registry.execute('computer.click', {}, { surface: 'http', scope }), refusal(403, 'Click on the screen can only be used from this machine'), JSON.stringify(scope));
  }
  assert.deepEqual(runs, []);

  assert.deepEqual(await registry.execute('chrome.open', {}, { surface: 'http', scope: { local: true } }), { ran: 'chrome.open' });
  assert.deepEqual(await registry.execute('jira.get_issue', {}, { surface: 'http', scope: { local: false } }), { read: true });
  assert.deepEqual(await registry.execute('computer.click', {}, { surface: 'agent', tool: COMPUTER }), { ran: 'computer.click' });
});

test('a tool its switch refuses answers that refusal on every surface and runs nothing', async () => {
  const { registry, control, runs } = setUp();
  const asked = [];
  registry.useSwitches(async (tool) => {
    asked.push(tool);
    return tool === CHROME ? new MittrToolError('The Chrome tool is turned off in Settings → Integrations', 403) : null;
  });

  for (const ctx of [{ surface: 'agent', tool: CHROME }, { surface: 'voice' }, { surface: 'http', scope: { local: true } }]) {
    await assert.rejects(registry.execute('chrome.open', {}, ctx), refusal(403, 'The Chrome tool is turned off in Settings → Integrations'), ctx.surface);
  }
  assert.deepEqual(runs, []);
  assert.deepEqual(await registry.execute('computer.click', {}, { surface: 'voice' }), { ran: 'computer.click' });
  assert.deepEqual(await registry.execute('session.list', {}, { surface: 'voice' }), { sessions: [] });
  assert.equal(control.calls.length, 1);
  assert.deepEqual(asked, [CHROME, CHROME, CHROME, COMPUTER]);
});

test('the MittrCraft tool names are fixed', () => {
  assert.deepEqual(MITTR_TOOLS, { computer: 'mittrcraft_computer', chrome: 'mittrcraft_chrome', work: 'mittrcraft_work' });
});

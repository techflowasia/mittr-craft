import assert from 'node:assert/strict';
import test from 'node:test';

import { MittrToolError, createMittrActionRegistry } from './registry.js';

const UPSTREAM_DEFINITIONS = {
  control: [
    { action: 'session.list', title: 'List sessions', description: 'List sessions' },
    { action: 'session.create', title: 'Create a session', description: 'Create a session' },
  ],
  web: [
    { action: 'browser.open', title: 'Open a page in the browser panel', description: 'Open url' },
  ],
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
  };
};

const CHROME = 'mittrcraft_chrome';
const COMPUTER = 'mittrcraft_computer';

const setUp = ({ control = fakeControl(), chromeAvailable = () => true } = {}) => {
  const registry = createMittrActionRegistry({ control });
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
  return { registry, control, runs };
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
    action: 'session.stop', tool: CHROME, title: 'Stop the answer', description: 'Stop', effect: 'change', voiceOnly: true,
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
    action: 'computer.screenshot', tool: COMPUTER, title: 'Look at the screen', description: 'Screenshot', effect: 'read', voiceOnly: false,
  });
});

test('an action registered twice, under an unknown tool or with an upstream name throws', () => {
  const { registry } = setUp();
  const entry = { tool: CHROME, title: 'T', description: 'D', effect: 'read', execute: async () => ({}) };

  assert.throws(() => registry.register({ ...entry, action: 'chrome.open' }), /chrome\.open is already registered/);
  assert.throws(() => registry.register({ ...entry, action: 'chrome.x', tool: 'mittrcraft_nothing' }), /mittrcraft_nothing is not a defined tool/);
  assert.throws(() => registry.register({ ...entry, action: 'chrome.x', effect: 'write' }), /effect/);
  assert.throws(() => registry.register({ ...entry, action: 'session.create' }), /session\.create is an upstream action/);
  assert.throws(() => registry.register({ ...entry, action: 'browser.open' }), /browser\.open is an upstream action/);
  assert.throws(() => registry.defineTool({ name: CHROME, description: 'again', parameters: {} }), /mittrcraft_chrome is already defined/);
  assert.equal(registry.has('session.create'), false);
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

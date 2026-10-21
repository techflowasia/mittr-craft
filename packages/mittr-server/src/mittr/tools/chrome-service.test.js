import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { MARKER_PNG } from '../../../../../scripts/mittr/probe-tool-plugin.mjs';
import { OPENCHAMBER_ALL_ACTIONS } from '../../../../web/server/lib/openchamber-control/actions.js';
import { writeScreenshot } from '../../../../web/server/lib/openchamber-control/screenshots.js';
import { tempDataDir } from '../test-helpers.js';
import { BANNER_FILE, CONFIG_FILE, createChromeControl } from './chrome-control.js';
import { CHROME_TOOL_DESCRIPTION, NO_APPROVALS, createChromeService, registerChromeActions } from './chrome-service.js';
import { MITTR_TOOLS, createMittrActionRegistry } from './registry.js';

const BINARY = '/r/agent-browser/agent-browser';

const commandOf = (argv) => {
  const capped = argv.indexOf('--max-output');
  return capped === -1 ? argv.slice(argv.indexOf('--json') + 1) : argv.slice(capped + 2);
};

const optionOf = (argv, flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);

const fakeBrowser = ({ profiles = [{ directory: 'Default', name: 'Person' }], redirects = {}, clickTo = null, screenshot = 'png', running = [] } = {}) => {
  const calls = [];
  const urls = new Map();
  const execute = async (_binary, argv, { signal }) => {
    calls.push(argv);
    const session = optionOf(argv, '--session');
    const [command, ...rest] = commandOf(argv);
    const reply = (data) => JSON.stringify({ success: true, data });
    if (signal?.aborted) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    if (command === 'profiles') return reply(profiles);
    if (command === 'session') return reply({ sessions: running });
    if (command === 'close') {
      if (rest[0] === '--all') urls.clear();
      else urls.delete(session);
      return reply({ closed: true });
    }
    if (command === 'open') {
      urls.set(session, redirects[rest[0]] ?? rest[0]);
      return reply({ url: rest[0], title: 'Acme', lifecycle: { launched: true } });
    }
    if (command === 'get') return reply({ url: urls.get(session) ?? 'about:blank' });
    if (command === 'click') {
      if (clickTo) urls.set(session, clickTo);
      return reply({ clicked: true, secret: 'page text from wherever it landed' });
    }
    if (command === 'screenshot') {
      if (screenshot === 'fails') return JSON.stringify({ success: false, error: 'capture failed' });
      if (screenshot === 'moves') urls.set(session, 'https://evil.example.test/');
      fs.writeFileSync(rest[0], Buffer.from(MARKER_PNG, 'base64'));
      return reply({ path: rest[0] });
    }
    if (command === 'snapshot') return reply({ snapshot: '- textbox "Name" [ref=e1]\n- button "Send" [ref=e2]' });
    return reply({ ran: command, args: rest });
  };
  return { calls, urls, execute, commands: () => calls.map(commandOf) };
};

const allowHosts = (...hosts) => {
  const record = { forgotten: [], forgotAll: 0, decisions: [] };
  const allowed = new Set(hosts);
  return {
    record,
    isApproved: async (_sessionId, host) => allowed.has(host),
    awaitDecision: async (sessionId, host) => {
      record.decisions.push([sessionId, host]);
      if (record.reply === 'once') allowed.add(host);
      return record.reply ?? null;
    },
    forgetSession: (sessionId) => record.forgotten.push(sessionId),
    forgetAll: () => { record.forgotAll += 1; },
    removeHost: async (host) => [host],
  };
};

const fakeSettings = (tools = {}) => {
  const state = { tools: { computer: true, chrome: true, chromeProfile: 'Default', chromeHeaded: false, chromeApprovedHosts: [], ...tools }, updates: [] };
  return {
    state,
    read: async () => ({ showOtherProviders: false, tools: { ...state.tools } }),
    update: async (patch) => {
      state.updates.push(patch);
      state.tools = { ...state.tools, ...patch.tools };
    },
  };
};

const setUp = (t, { browser = fakeBrowser(), approvals = allowHosts('acme.example.test'), tools, ownPorts = () => [4100, 4096], installed = true } = {}) => {
  const dataDir = tempDataDir(t);
  const scratchRoot = tempDataDir(t);
  const project = fs.realpathSync(tempDataDir(t));
  const control = createChromeControl({ binary: BINARY, dataDir, execute: browser.execute, env: {}, exists: () => installed });
  const settings = fakeSettings(tools);
  const service = createChromeService({ control, settings, approvals, writeScreenshot, ownPorts, scratchRoot });
  const ctx = { sessionId: 'ses_1', directory: project, surface: 'agent', tool: MITTR_TOOLS.chrome };
  return { browser, service, settings, approvals, dataDir, scratchRoot, project, ctx };
};

const refusal = (statusCode, message, extra = {}) => (error) => {
  assert.equal(error.message, message);
  assert.equal(error.statusCode, statusCode);
  for (const [key, value] of Object.entries(extra)) assert.equal(error[key], value, key);
  return true;
};

test('chrome.open runs agent-browser with the session, profile and json flags', async (t) => {
  const { service, browser, dataDir, ctx } = setUp(t);
  assert.deepEqual(await service.execute('chrome.open', { url: 'https://acme.example.test/' }, ctx), { url: 'https://acme.example.test/', title: 'Acme' });
  const base = ['--config', path.join(dataDir, CONFIG_FILE), '--session', 'mc-ses_1', '--profile', 'Default', '--json', '--max-output', '12000'];
  assert.deepEqual(browser.calls, [[...base, 'open', 'https://acme.example.test/'], [...base, 'get', 'url']]);
});

test('a value starting with - is refused for every chrome action', async (t) => {
  const { service, browser, ctx } = setUp(t);
  for (const [action, input, name] of [
    ['chrome.fill', { ref: '@e1', value: '--headed' }, 'value'],
    ['chrome.type', { ref: '@e1', value: '--profile' }, 'value'],
    ['chrome.select', { ref: '@e1', value: '-s' }, 'value'],
    ['chrome.snapshot', { selector: '--headed' }, 'selector'],
    ['chrome.snapshot', { selector: '-s' }, 'selector'],
    ['chrome.wait', { text: '--profile' }, 'text'],
    ['chrome.wait', { text: '-s' }, 'text'],
  ]) {
    await assert.rejects(service.execute(action, input, ctx), refusal(400, `${name} cannot start with "-"`), `${action} ${JSON.stringify(input)}`);
  }
  await assert.rejects(service.execute('chrome.open', { url: '--headed' }, ctx), refusal(400, 'url must be a full http(s) address'));
  await assert.rejects(service.execute('chrome.press', { key: '--profile' }, ctx), refusal(400, 'key must be a key name such as Enter, Tab or Control+a'));
  assert.deepEqual(browser.calls, [], 'no argv was run');
});

test('a ref that is not from a snapshot is refused', async (t) => {
  const { service, browser, ctx } = setUp(t);
  for (const ref of ['e1; rm', '#login', '@x1', '--headed', '', undefined]) {
    await assert.rejects(service.execute('chrome.click', { ref }, ctx), refusal(400, 'ref must be an element ref from chrome.snapshot, such as @e3'), String(ref));
  }
  assert.deepEqual(browser.calls, []);
});

test('only http and https pages open', async (t) => {
  const { service, browser, ctx } = setUp(t);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'about:blank', 'data:text/html,hi']) {
    await assert.rejects(service.execute('chrome.open', { url }, ctx), refusal(400, 'Only http(s) pages can be opened in Chrome'), url);
  }
  await assert.rejects(service.execute('chrome.open', { url: 'acme.example.test' }, ctx), refusal(400, 'url must be a full http(s) address'));
  await assert.rejects(service.execute('chrome.open', {}, ctx), refusal(400, 'url is required'));
  assert.deepEqual(browser.calls, []);
});

test('a click that lands on another host returns nothing from it and names the host', async (t) => {
  const { service, ctx } = setUp(t, { browser: fakeBrowser({ clickTo: 'https://evil.example.test/inbox' }) });
  await service.execute('chrome.open', { url: 'https://acme.example.test/' }, ctx);
  await assert.rejects(service.execute('chrome.click', { ref: 'e2' }, ctx), (error) => {
    refusal(409, 'The page moved to evil.example.test, which the user has not allowed; nothing from it is returned. Call chrome.open with that page\'s URL to ask the user', { code: 'site_moved', host: 'evil.example.test' })(error);
    assert.equal(JSON.stringify(error).includes('page text'), false);
    return true;
  });
});

test('chrome.open whose redirect leaves the approved host answers site_moved', async (t) => {
  const browser = fakeBrowser({ redirects: { 'https://acme.example.test/login': 'https://sso.example.test/auth' } });
  const { service, ctx } = setUp(t, { browser });
  await assert.rejects(service.execute('chrome.open', { url: 'https://acme.example.test/login' }, ctx), refusal(409, 'The page moved to sso.example.test, which the user has not allowed; nothing from it is returned. Call chrome.open with that page\'s URL to ask the user', { code: 'site_moved', host: 'sso.example.test' }));
});

test('every action asks the fence for the page it acts on, and a site not yet allowed opens nothing', async (t) => {
  const approvals = allowHosts();
  const { service, browser, ctx } = setUp(t, { approvals });
  await assert.rejects(service.execute('chrome.open', { url: 'https://Acme.Example.test/x' }, ctx), refusal(403, 'The user has not yet allowed using their Chrome sign-in on acme.example.test', { code: 'site_approval_required', host: 'acme.example.test' }));
  assert.deepEqual(browser.commands(), []);

  approvals.record.reply = 'reject';
  await assert.rejects(service.execute('chrome.open', { url: 'https://acme.example.test/x' }, { ...ctx, approvalAnswered: true }), refusal(403, 'The user did not allow using their Chrome sign-in on acme.example.test'));
  assert.deepEqual(browser.commands(), []);
  approvals.record.reply = 'once';
  await service.execute('chrome.open', { url: 'https://acme.example.test/x' }, { ...ctx, approvalAnswered: true });
  assert.deepEqual(approvals.record.decisions, [['ses_1', 'acme.example.test'], ['ses_1', 'acme.example.test']]);
  assert.deepEqual(browser.commands(), [['open', 'https://acme.example.test/x'], ['get', 'url']]);

  const other = setUp(t, { approvals: allowHosts() });
  other.browser.urls.set('mc-ses_1', 'https://acme.example.test/x');
  await assert.rejects(other.service.execute('chrome.read', {}, other.ctx), refusal(403, 'The user has not yet allowed using their Chrome sign-in on acme.example.test', { code: 'site_approval_required' }));
  assert.deepEqual(other.browser.commands(), [['get', 'url']], 'nothing is read from a page the user has not allowed');
});

test('chrome.open and the fence refuse MittrCraft\'s own ports whatever the approvals', async (t) => {
  const browser = fakeBrowser({ clickTo: 'http://127.0.0.1:4100/api/config' });
  const approvals = { ...allowHosts(), isApproved: async () => true };
  const { service, ctx } = setUp(t, { browser, approvals });
  for (const url of ['http://127.0.0.1:4100/', 'http://localhost:4096/session', 'http://[::1]:4100/', 'http://app.localhost:4096/']) {
    await assert.rejects(service.execute('chrome.open', { url }, ctx), refusal(400, 'That address is MittrCraft itself'), url);
  }
  assert.deepEqual(browser.commands(), []);

  await service.execute('chrome.open', { url: 'http://127.0.0.1:5173/' }, ctx);
  await assert.rejects(service.execute('chrome.click', { ref: '@e2' }, ctx), refusal(400, 'That address is MittrCraft itself'));
  await assert.rejects(service.execute('chrome.read', {}, ctx), refusal(400, 'That address is MittrCraft itself'));
  assert.equal(browser.commands().some(([command]) => command === 'read'), false);
});

test('the only profile is chosen and stored, two profiles ask the user', async (t) => {
  const one = setUp(t, { tools: { chromeProfile: null }, browser: fakeBrowser({ profiles: [{ directory: 'Profile 3', name: 'Work' }] }) });
  await one.service.execute('chrome.open', { url: 'https://acme.example.test/' }, one.ctx);
  assert.deepEqual(one.settings.state.updates, [{ tools: { chromeProfile: 'Profile 3' } }]);
  assert.equal(optionOf(one.browser.calls.at(-1), '--profile'), 'Profile 3');

  const two = setUp(t, { tools: { chromeProfile: null }, browser: fakeBrowser({ profiles: [{ directory: 'Default', name: 'Home' }, { directory: 'Profile 1', name: 'Work' }] }) });
  await assert.rejects(two.service.execute('chrome.open', { url: 'https://acme.example.test/' }, two.ctx), refusal(409, 'No Chrome profile is chosen yet; ask the user to choose one in Settings → Integrations → MittrCraft tools → Chrome profile', { code: 'chrome_profile_required' }));
  assert.deepEqual(two.browser.commands(), [['profiles']]);
  assert.deepEqual(two.settings.state.updates, []);
});

test('a headed request closes the headless session first and adds the banner', async (t) => {
  const { service, browser, dataDir, ctx, settings } = setUp(t);
  const noPage = refusal(400, 'No page is open in this session; call chrome.open first');
  await service.execute('chrome.open', { url: 'https://acme.example.test/' }, ctx);
  const opened = browser.calls.length;

  await assert.rejects(service.execute('chrome.read', {}, { ...ctx, headed: true }), noPage);
  const after = browser.calls.slice(opened);
  assert.deepEqual(commandOf(after[0]), ['close']);
  assert.equal(after[0].includes('--headed'), false, 'the headless Chrome is the one closed');
  assert.deepEqual(after.slice(1).map(commandOf), [['get', 'url']]);
  assert.deepEqual(after[1].slice(after[1].indexOf('--headed'), after[1].indexOf('--headed') + 3), ['--headed', '--init-script', path.join(dataDir, BANNER_FILE)]);

  const headed = browser.calls.length;
  await service.execute('chrome.open', { url: 'https://acme.example.test/' }, { ...ctx, headed: true });
  assert.equal(browser.calls.slice(headed).some((argv) => commandOf(argv)[0] === 'close'), false, 'the same mode is not closed again');

  settings.state.tools.chromeProfile = 'Profile 1';
  settings.state.tools.chromeHeaded = true;
  const before = browser.calls.length;
  await assert.rejects(service.execute('chrome.read', {}, ctx), noPage);
  const reopened = browser.calls.slice(before);
  assert.deepEqual(commandOf(reopened[0]), ['close'], 'a new profile closes the Chrome on the old one');
  assert.equal(optionOf(reopened[0], '--profile'), 'Default');
  assert.equal(optionOf(reopened[1], '--profile'), 'Profile 1');
  assert.ok(reopened[1].includes('--headed'), 'the stored visible-window setting applies');
});

test('a first headed request on a session this run never started launches nothing to close', async (t) => {
  const { service, browser, ctx } = setUp(t);
  await service.execute('chrome.open', { url: 'https://acme.example.test/' }, { ...ctx, headed: true });
  assert.deepEqual(browser.commands(), [['open', 'https://acme.example.test/'], ['get', 'url']]);
});

test('a screenshot is saved and its scratch folder is removed even when the driver fails', async (t) => {
  const { service, scratchRoot, project, ctx } = setUp(t);
  await service.execute('chrome.open', { url: 'https://acme.example.test/' }, ctx);
  const shot = await service.execute('chrome.screenshot', { label: 'Inbox', directory: '/somewhere/else' }, ctx);
  assert.match(shot.path, /^\.openchamber\/screenshots\/inbox-.+\.png$/);
  assert.deepEqual(fs.readFileSync(path.join(project, shot.path)), Buffer.from(MARKER_PNG, 'base64'));
  assert.deepEqual(shot.image, { base64: MARKER_PNG, mime: 'image/png' });
  assert.equal(shot.url, 'https://acme.example.test/');
  assert.equal(shot.hint, `The image is attached for you to view directly; write ![](${shot.path}) in your reply to also show it to the user.`);
  assert.deepEqual(fs.readdirSync(scratchRoot), []);
  assert.match((await service.execute('chrome.screenshot', {}, ctx)).path, /^\.openchamber\/screenshots\/chrome-.+\.png$/);

  const failing = setUp(t, { browser: fakeBrowser({ screenshot: 'fails' }) });
  await failing.service.execute('chrome.open', { url: 'https://acme.example.test/' }, failing.ctx);
  await assert.rejects(failing.service.execute('chrome.screenshot', {}, failing.ctx), /capture failed/);
  assert.deepEqual(fs.readdirSync(failing.scratchRoot), []);
  assert.equal(fs.existsSync(path.join(failing.project, '.openchamber')), false);

  const nowhere = setUp(t);
  await assert.rejects(nowhere.service.execute('chrome.screenshot', {}, { ...nowhere.ctx, directory: undefined }), refusal(400, 'A project directory is required to save a screenshot'));
  assert.deepEqual(nowhere.browser.calls, []);
});

test('a screenshot of a page that moved is neither saved nor returned', async (t) => {
  const { service, scratchRoot, project, ctx } = setUp(t, { browser: fakeBrowser({ screenshot: 'moves' }) });
  await service.execute('chrome.open', { url: 'https://acme.example.test/' }, ctx);
  await assert.rejects(service.execute('chrome.screenshot', {}, ctx), refusal(409, 'The page moved to evil.example.test, which the user has not allowed; nothing from it is returned. Call chrome.open with that page\'s URL to ask the user', { code: 'site_moved' }));
  assert.equal(fs.existsSync(path.join(project, '.openchamber')), false);
  assert.deepEqual(fs.readdirSync(scratchRoot), []);
});

test('every page action runs on the open page and is checked after it', async (t) => {
  const { service, browser, ctx } = setUp(t);
  await assert.rejects(service.execute('chrome.snapshot', {}, ctx), refusal(400, 'No page is open in this session; call chrome.open first'));
  await service.execute('chrome.open', { url: 'https://acme.example.test/' }, ctx);
  const opened = browser.calls.length;
  for (const [action, input] of [
    ['chrome.snapshot', {}],
    ['chrome.snapshot', { selector: 'form#login' }],
    ['chrome.read', {}],
    ['chrome.click', { ref: '@e2' }],
    ['chrome.fill', { ref: 'e1', value: '' }],
    ['chrome.type', { ref: '@e1', value: 'acme' }],
    ['chrome.press', { key: 'Control+a' }],
    ['chrome.select', { ref: '@e3', value: 'Thai' }],
    ['chrome.wait', { text: 'Saved' }],
    ['chrome.wait', { ref: '@e4' }],
  ]) await service.execute(action, input, ctx);
  const pageCommands = browser.commands().slice(opened).filter(([command]) => command !== 'get');
  assert.deepEqual(pageCommands, [
    ['snapshot', '-i'],
    ['snapshot', '-i', '-s', 'form#login'],
    ['read'],
    ['click', '@e2'],
    ['fill', '@e1', ''],
    ['type', '@e1', 'acme'],
    ['press', 'Control+a'],
    ['select', '@e3', 'Thai'],
    ['wait', '--text', 'Saved'],
    ['wait', '@e4'],
  ]);
  assert.equal(browser.commands().slice(opened).filter(([command]) => command === 'get').length, 20, 'one page check before and one after each action');
  await assert.rejects(service.execute('chrome.do', { goal: 'x' }, ctx), refusal(400, 'Unsupported Chrome action: chrome.do'));
});

test('a turn cancelled mid-action closes that session\'s Chrome', async (t) => {
  const browser = fakeBrowser();
  const controller = new AbortController();
  const cancelling = {
    ...browser,
    execute: async (binary, argv, options) => {
      if (commandOf(argv)[0] !== 'read') return browser.execute(binary, argv, options);
      controller.abort();
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    },
  };
  const { service, ctx } = setUp(t, { browser: cancelling });
  await service.execute('chrome.open', { url: 'https://acme.example.test/' }, ctx);
  await assert.rejects(service.execute('chrome.read', {}, { ...ctx, signal: controller.signal }), refusal(499, 'The Chrome action was cancelled'));
  assert.deepEqual(commandOf(browser.calls.at(-1)), ['close']);
  assert.equal(optionOf(browser.calls.at(-1), '--session'), 'mc-ses_1');
});

test('chrome.close and a deleted session close only a Chrome that is running, and forget the session\'s grants', async (t) => {
  const browser = fakeBrowser({ running: ['mc-ses_old'] });
  const { service, approvals, ctx } = setUp(t, { browser });
  assert.deepEqual(await service.execute('chrome.close', {}, ctx), { closed: true });
  assert.deepEqual(browser.commands(), [['session', 'list']], 'nothing is launched to close a Chrome that never ran');

  await service.execute('chrome.open', { url: 'https://acme.example.test/' }, ctx);
  service.allowForConversation('ses_1');
  await service.closeSession('ses_1');
  assert.deepEqual(browser.commands().at(-1), ['close']);
  assert.equal(optionOf(browser.calls.at(-1), '--session'), 'mc-ses_1');
  assert.equal(await service.isHostAllowed('ses_1', 'other.example.test'), false);
  assert.deepEqual(approvals.record.forgotten, ['ses_1', 'ses_1']);

  await service.closeSession('ses_old');
  assert.equal(optionOf(browser.calls.at(-1), '--session'), 'mc-ses_old', 'a Chrome left from an earlier run is closed too');
  await service.closeSession('');
});

test('a conversation grant allows every host for that session until the conversation ends', async (t) => {
  const { service, approvals } = setUp(t, { approvals: allowHosts('acme.example.test') });
  assert.equal(await service.isHostAllowed('ses_1', 'other.example.test'), false);
  service.allowForConversation('ses_1');
  assert.equal(await service.isHostAllowed('ses_1', 'other.example.test'), true);
  assert.equal(await service.isHostAllowed('ses_2', 'other.example.test'), false);
  assert.equal(await service.isHostAllowed('ses_2', 'acme.example.test'), true);
  service.endConversation('ses_1');
  assert.equal(await service.isHostAllowed('ses_1', 'other.example.test'), false);
  assert.deepEqual(approvals.record.forgotten, ['ses_1']);

  service.allowForConversation('ses_3');
  service.forgetEveryGrant();
  assert.equal(await service.isHostAllowed('ses_3', 'other.example.test'), false);
  assert.equal(approvals.record.forgotAll, 1);
});

test('the Chrome tool needs the calling session, a bundled driver\'s Chrome and an approvals source', async (t) => {
  const { service, browser } = setUp(t);
  await assert.rejects(service.execute('chrome.open', { url: 'https://acme.example.test/' }, { surface: 'http' }), refusal(400, 'The Chrome tool needs the calling session'));
  const missing = setUp(t, { installed: false });
  await assert.rejects(missing.service.execute('chrome.open', { url: 'https://acme.example.test/' }, missing.ctx), refusal(503, 'Google Chrome is not installed on this Mac; ask the user to install it'));
  assert.deepEqual([...browser.calls, ...missing.browser.calls], []);

  const denied = setUp(t, { approvals: NO_APPROVALS });
  await assert.rejects(denied.service.execute('chrome.open', { url: 'https://acme.example.test/' }, denied.ctx), refusal(403, 'The user has not yet allowed using their Chrome sign-in on acme.example.test'));
  assert.equal(await NO_APPROVALS.isApproved('ses_1', 'acme.example.test'), false);
});

test('profiles and removeHost answer through the driver and the approvals', async (t) => {
  const { service } = setUp(t);
  assert.deepEqual(await service.profiles(), [{ directory: 'Default', name: 'Person' }]);
  assert.deepEqual(await service.removeHost(' Acme.Example.test '), ['acme.example.test']);
  await assert.rejects(service.removeHost(' '), refusal(400, 'host is required'));
  const unbundled = createChromeService({ control: createChromeControl({ binary: null, dataDir: tempDataDir(t), env: {} }), settings: fakeSettings(), approvals: NO_APPROVALS, writeScreenshot });
  assert.deepEqual(await unbundled.profiles(), []);
});

test('the tool description says never to type a password', () => {
  assert.ok(CHROME_TOOL_DESCRIPTION.endsWith('If a page asks you to sign in, stop and tell the user which site — never type a password or fill a sign-in form.'));
  assert.match(CHROME_TOOL_DESCRIPTION, /To look at the app being built, use openchamber_web instead\./);
});

test('the Chrome actions are registered on mittrcraft_chrome, with their effects', (t) => {
  const registry = createMittrActionRegistry({ control: { all: OPENCHAMBER_ALL_ACTIONS, execute: async () => ({}) } });
  const { service } = setUp(t);
  const offered = { value: true };
  registerChromeActions(registry, { service, available: () => offered.value });
  const definitions = registry.definitions({ tool: MITTR_TOOLS.chrome });
  assert.deepEqual(definitions.map(({ action, effect }) => [action, effect]), [
    ['chrome.open', 'read'],
    ['chrome.snapshot', 'read'],
    ['chrome.read', 'read'],
    ['chrome.click', 'change'],
    ['chrome.fill', 'change'],
    ['chrome.type', 'change'],
    ['chrome.press', 'change'],
    ['chrome.select', 'change'],
    ['chrome.wait', 'read'],
    ['chrome.screenshot', 'read'],
    ['chrome.close', 'change'],
  ]);
  const [tool] = registry.tools();
  assert.equal(tool.description, CHROME_TOOL_DESCRIPTION);
  assert.deepEqual(Object.keys(tool.parameters), ['url', 'ref', 'value', 'key', 'text', 'selector', 'label']);
  offered.value = false;
  assert.deepEqual(registry.tools(), []);
});

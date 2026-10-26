import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { MARKER_PNG } from '../../../../../scripts/mittr/probe-tool-plugin.mjs';
import { OPENCHAMBER_ALL_ACTIONS } from '../../../../web/server/lib/openchamber-control/actions.js';
import { writeScreenshot } from '../../../../web/server/lib/openchamber-control/screenshots.js';
import { deferred, fakeFetch, json, tempDataDir } from '../test-helpers.js';
import { BANNER_FILE, CONFIG_FILE, chromeSessionName, createChromeControl } from './chrome-control.js';
import { createBrowserStepper } from './browser-stepper.js';
import { NO_APPROVALS, chromeToolDescription, chromeToolParameters, createChromeService, registerChromeActions } from './chrome-service.js';
import { MITTR_TOOLS, MittrToolError, createMittrActionRegistry } from './registry.js';

const BINARY = '/r/agent-browser/agent-browser';
const SES_1 = chromeSessionName('ses_1');

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
    if (command === 'session') return reply({ sessions: [...new Set([...running, ...urls.keys()])] });
    if (command === 'close') {
      if (rest[0] === '--all') urls.clear();
      else urls.delete(session);
      return reply({ closed: true });
    }
    if (command === 'open') {
      urls.set(session, redirects[rest[0]] ?? rest[0]);
      return reply({ url: rest[0], title: 'Acme', lifecycle: { launched: true } });
    }
    if (command === 'get') return rest[0] === 'title' ? reply({ title: urls.has(session) ? 'Acme home' : '' }) : reply({ url: urls.get(session) ?? 'about:blank' });
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
  const record = { forgotten: [], forgotAll: 0, asks: [] };
  const allowed = new Set(hosts);
  return {
    record,
    isApproved: async (_sessionId, host) => allowed.has(host),
    ask: async ({ sessionId, host, directory, source, signal }) => {
      record.asks.push({ sessionId, host, directory, source, aborted: signal?.aborted === true });
      if (record.reply === 'cancel') throw new MittrToolError('Cancelled while waiting for the user', 499);
      if (record.reply === 'once' || record.reply === 'always') allowed.add(host);
      return record.reply ?? 'reject';
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

const setUp = (t, { browser = fakeBrowser(), approvals = allowHosts('acme.example.test'), tools, ownPorts = () => [4100, 4096], installed = true, lookup = async () => [{ address: '192.0.2.10', family: 4 }], stepper = null } = {}) => {
  const dataDir = tempDataDir(t);
  const scratchRoot = tempDataDir(t);
  const project = fs.realpathSync(tempDataDir(t));
  const control = createChromeControl({ binary: BINARY, dataDir, execute: browser.execute, env: {}, exists: () => installed });
  const settings = fakeSettings(tools);
  const service = createChromeService({ control, settings, approvals, writeScreenshot, ownPorts, lookup, scratchRoot, stepper });
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
  const config = ['--config', path.join(dataDir, CONFIG_FILE)];
  const base = [...config, '--session', SES_1, '--profile', 'Default', '--json', '--max-output', '12000'];
  assert.deepEqual(browser.calls, [[...config, '--json', 'profiles'], [...base, 'open', 'https://acme.example.test/'], [...base, 'get', 'url']]);
  assert.match(SES_1, /^mc-[0-9a-f]{10}$/);
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

test('Don\'t allow answers the refusal and opens nothing: the server itself asks for a site not yet allowed', async (t) => {
  const approvals = allowHosts();
  const { service, browser, ctx, project } = setUp(t, { approvals });
  const source = { type: 'tool', messageID: 'msg_1', id: 'call_1' };
  await assert.rejects(service.execute('chrome.open', { url: 'https://Acme.Example.test/x' }, { ...ctx, source }), refusal(403, 'The user did not allow using their Chrome sign-in on acme.example.test'));
  const launches = () => browser.commands().filter(([command]) => command !== 'profiles');
  assert.deepEqual(launches(), []);
  assert.deepEqual(approvals.record.asks, [{ sessionId: 'ses_1', host: 'acme.example.test', directory: project, source, aborted: false }]);
});

test('Allow once lets the call through and the next call asks nothing', async (t) => {
  const approvals = allowHosts();
  const { service, browser, ctx } = setUp(t, { approvals });
  approvals.record.reply = 'once';
  await service.execute('chrome.open', { url: 'https://acme.example.test/x' }, ctx);
  await service.execute('chrome.read', {}, ctx);
  assert.equal(approvals.record.asks.length, 1);
  assert.deepEqual(browser.commands().filter(([command]) => command !== 'profiles'), [['open', 'https://acme.example.test/x'], ['get', 'url'], ['get', 'url'], ['read'], ['get', 'url']]);
});

test('an aborted turn stops waiting and opens nothing', async (t) => {
  const approvals = allowHosts();
  const { service, browser, ctx } = setUp(t, { approvals });
  approvals.record.reply = 'cancel';
  await assert.rejects(service.execute('chrome.open', { url: 'https://acme.example.test/x' }, ctx), refusal(499, 'Cancelled while waiting for the user'));
  assert.deepEqual(browser.commands().filter(([command]) => command !== 'profiles'), []);
});

test('every action asks about the page it acts on, and nothing is read from a page the user did not allow', async (t) => {
  const approvals = allowHosts();
  const { service, browser, ctx } = setUp(t, { approvals });
  browser.urls.set(SES_1, 'https://acme.example.test/x');
  await assert.rejects(service.execute('chrome.read', {}, ctx), refusal(403, 'The user did not allow using their Chrome sign-in on acme.example.test'));
  assert.deepEqual(browser.commands(), [['session', 'list'], ['profiles'], ['get', 'url']]);
  assert.deepEqual(approvals.record.asks.map(({ host }) => host), ['acme.example.test']);
});

test('without an approvals source every site is refused as not yet allowed', async (t) => {
  const { service, browser, ctx } = setUp(t, { approvals: NO_APPROVALS });
  await assert.rejects(service.execute('chrome.open', { url: 'https://acme.example.test/x' }, ctx), refusal(403, 'The user has not yet allowed using their Chrome sign-in on acme.example.test', { code: 'site_approval_required', host: 'acme.example.test' }));
  assert.deepEqual(browser.commands().filter(([command]) => command !== 'profiles'), []);
});

test('chrome.open and the fence refuse MittrCraft\'s own ports whatever the approvals', async (t) => {
  const browser = fakeBrowser({ clickTo: 'http://127.0.0.1:4100/api/config' });
  const approvals = { ...allowHosts(), isApproved: async () => true };
  const { service, ctx } = setUp(t, { browser, approvals });
  for (const url of [
    'http://127.0.0.1:4100/',
    'http://localhost:4096/session',
    'http://[::1]:4100/',
    'http://app.localhost:4096/',
    'http://localhost.:4100/',
    'http://APP.LOCALHOST..:4096/',
    'http://[::ffff:127.0.0.2]:4100/',
    'http://[::ffff:0.0.0.0]:4096/',
    'http://[::]:4100/',
    'http://0.0.0.0:4100/',
    'http://127.1.2.3:4096/',
    'http://2130706433:4100/',
    'http://0x7f000001:4100/',
  ]) {
    await assert.rejects(service.execute('chrome.open', { url }, ctx), refusal(400, 'That address is MittrCraft itself'), url);
  }
  assert.deepEqual(browser.commands().filter(([command]) => command !== 'profiles'), []);

  await service.execute('chrome.open', { url: 'http://127.0.0.1:5173/' }, ctx);
  await assert.rejects(service.execute('chrome.click', { ref: '@e2' }, ctx), refusal(400, 'That address is MittrCraft itself'));
  await assert.rejects(service.execute('chrome.read', {}, ctx), refusal(400, 'That address is MittrCraft itself'));
  assert.equal(browser.commands().some(([command]) => command === 'read'), false);
});

test('a name that resolves to this machine on MittrCraft\'s port is refused, and so is one that cannot be resolved', async (t) => {
  const asked = [];
  const answers = {
    'lvh.example.test': [{ address: '127.0.0.1', family: 4 }],
    'mixed.example.test': [{ address: '192.0.2.1', family: 4 }, { address: '::1', family: 6 }],
    'mapped.example.test': [{ address: '::ffff:127.0.0.1', family: 6 }],
    'public.example.test': [{ address: '192.0.2.1', family: 4 }],
  };
  const lookup = async (host) => {
    asked.push(host);
    if (!answers[host]) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return answers[host];
  };
  const approvals = { ...allowHosts(), isApproved: async () => true };
  const { service, browser, ctx } = setUp(t, { approvals, lookup });
  for (const host of ['lvh.example.test', 'mixed.example.test', 'mapped.example.test', 'missing.example.test']) {
    await assert.rejects(service.execute('chrome.open', { url: `http://${host}:4100/` }, ctx), refusal(400, 'That address is MittrCraft itself'), host);
  }
  assert.equal(browser.commands().some(([command]) => command === 'open'), false);
  await service.execute('chrome.open', { url: 'http://public.example.test:4100/' }, ctx);
  await service.execute('chrome.open', { url: 'http://lvh.example.test:5173/' }, ctx);
  assert.deepEqual(asked, ['lvh.example.test', 'mixed.example.test', 'mapped.example.test', 'missing.example.test', 'public.example.test', 'public.example.test'], 'only MittrCraft\'s ports are looked up');

  const slow = setUp(t, { approvals, lookup: () => new Promise(() => {}) });
  await assert.rejects(slow.service.execute('chrome.open', { url: 'http://slow.example.test:4096/' }, slow.ctx), refusal(400, 'That address is MittrCraft itself'));
});

test('a stored profile that is a flag, a folder or not one of this Mac\'s profiles is refused', async (t) => {
  const message = 'The chosen Chrome profile is not one of this Mac\'s Chrome profiles; ask the user to choose one in Settings → Integrations → MittrCraft tools → Chrome profile';
  for (const chromeProfile of ['--headed', '-s', '/Users/person/Library/Application Support/Google/Chrome', 'Profile 1/..', '..', '~', 'Profile 1\\x', 'Profile\u00001']) {
    const { service, browser, ctx } = setUp(t, { tools: { chromeProfile } });
    await assert.rejects(service.execute('chrome.open', { url: 'https://acme.example.test/' }, ctx), refusal(409, message, { code: 'chrome_profile_required' }), chromeProfile);
    assert.deepEqual(browser.calls, [], chromeProfile);
  }
  const unlisted = setUp(t, { tools: { chromeProfile: 'Profile 9' } });
  await assert.rejects(unlisted.service.execute('chrome.open', { url: 'https://acme.example.test/' }, unlisted.ctx), refusal(409, message, { code: 'chrome_profile_required' }));
  assert.deepEqual(unlisted.browser.commands(), [['profiles']]);
  const listedFolder = setUp(t, { tools: { chromeProfile: null }, browser: fakeBrowser({ profiles: [{ directory: '/tmp/elsewhere', name: 'Odd' }] }) });
  await assert.rejects(listedFolder.service.execute('chrome.open', { url: 'https://acme.example.test/' }, listedFolder.ctx), refusal(409, 'No Chrome profile is chosen yet; ask the user to choose one in Settings → Integrations → MittrCraft tools → Chrome profile'));
  assert.deepEqual(listedFolder.settings.state.updates, []);
});

test('the URL the fence checked is the URL the driver opens', async (t) => {
  const { service, browser, ctx } = setUp(t);
  await service.execute('chrome.open', { url: ' https://ACME.example.test/a b?q=1#x ' }, ctx);
  assert.deepEqual(browser.commands().find(([command]) => command === 'open'), ['open', 'https://acme.example.test/a%20b?q=1#x']);
});

test('a landing the driver does not report, or that is not a web page, returns nothing and names only its scheme', async (t) => {
  for (const [landed, message, host] of [
    [undefined, 'The page moved to an address the driver did not report, which the user has not allowed; nothing from it is returned. Call chrome.open with that page\'s URL to ask the user', undefined],
    ['file:///Users/person/secret.txt', 'The page moved to a file: page, which the user has not allowed; nothing from it is returned. Call chrome.open with that page\'s URL to ask the user', 'file:'],
    ['data:text/html,<h1>secret</h1>', 'The page moved to a data: page, which the user has not allowed; nothing from it is returned. Call chrome.open with that page\'s URL to ask the user', 'data:'],
  ]) {
    const browser = fakeBrowser();
    const moving = {
      ...browser,
      execute: async (binary, argv, options) => {
        if (commandOf(argv)[0] === 'click') browser.urls.set(SES_1, landed);
        if (commandOf(argv)[0] === 'get' && browser.urls.get(SES_1) === undefined && browser.urls.has(SES_1)) return JSON.stringify({ success: true, data: {} });
        return browser.execute(binary, argv, options);
      },
    };
    const { service, ctx } = setUp(t, { browser: moving });
    await service.execute('chrome.open', { url: 'https://acme.example.test/' }, ctx);
    await assert.rejects(service.execute('chrome.click', { ref: '@e2' }, ctx), (error) => {
      refusal(409, message, { code: 'site_moved' })(error);
      assert.equal(error.host, host);
      assert.equal(error.message.includes('secret'), false);
      return true;
    }, String(landed));
  }
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
  const { service, browser, dataDir, ctx, settings } = setUp(t, { browser: fakeBrowser({ profiles: [{ directory: 'Default', name: 'Home' }, { directory: 'Profile 1', name: 'Work' }] }) });
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
  const reopened = browser.calls.slice(before).filter((argv) => commandOf(argv)[0] !== 'profiles');
  assert.deepEqual(commandOf(reopened[0]), ['close'], 'a new profile closes the Chrome on the old one');
  assert.equal(optionOf(reopened[0], '--profile'), 'Default');
  assert.equal(optionOf(reopened[1], '--profile'), 'Profile 1');
  assert.ok(reopened[1].includes('--headed'), 'the stored visible-window setting applies');
});

test('a first headed request on a session this run never started launches nothing to close', async (t) => {
  const { service, browser, ctx } = setUp(t);
  await service.execute('chrome.open', { url: 'https://acme.example.test/' }, { ...ctx, headed: true });
  assert.deepEqual(browser.commands(), [['profiles'], ['open', 'https://acme.example.test/'], ['get', 'url']]);
});

test('a page action on a session this run never opened answers no page open without launching Chrome', async (t) => {
  const { service, browser, ctx } = setUp(t);
  for (const action of ['chrome.snapshot', 'chrome.read', 'chrome.screenshot']) {
    await assert.rejects(service.execute(action, {}, ctx), refusal(400, 'No page is open in this session; call chrome.open first'), action);
  }
  assert.deepEqual(browser.commands(), [['session', 'list'], ['session', 'list'], ['session', 'list']]);
});

test('the service waits for the start-up sweep before it drives Chrome', async (t) => {
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  const browser = fakeBrowser();
  const control = createChromeControl({ binary: BINARY, dataDir: tempDataDir(t), execute: browser.execute, env: {}, exists: () => true });
  const service = createChromeService({ control, settings: fakeSettings(), approvals: allowHosts('acme.example.test'), writeScreenshot, ready });
  const opening = service.execute('chrome.open', { url: 'https://acme.example.test/' }, { sessionId: 'ses_1' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(browser.calls, []);
  release();
  await opening;
  assert.equal(browser.commands().some(([command]) => command === 'open'), true);
});

test('a Chrome action running when every Chrome is closed keeps no session after it and ends with the account change', async (t) => {
  const base = fakeBrowser();
  const opening = deferred();
  const release = deferred();
  const browser = {
    ...base,
    execute: async (binary, argv, options) => {
      if (commandOf(argv)[0] === 'open') {
        opening.resolve();
        await release.promise;
      }
      return base.execute(binary, argv, options);
    },
  };
  const { service, ctx } = setUp(t, { browser });
  const opened = service.execute('chrome.open', { url: 'http://acme.example.test/' }, ctx);
  await opening.promise;

  await service.closeAll();
  release.resolve();

  await assert.rejects(opened, refusal(409, 'The Mittr account changed'));
  assert.deepEqual(base.commands(), [['profiles'], ['close', '--all'], ['open', 'http://acme.example.test/'], ['close']]);
  assert.equal(base.urls.has(SES_1), false);
  await assert.rejects(service.execute('chrome.read', {}, ctx), refusal(400, 'No page is open in this session; call chrome.open first'));
});

test('a Chrome action waiting for the person when every Chrome is closed launches nothing after the answer', async (t) => {
  const asking = deferred();
  const answer = deferred();
  const approvals = {
    ...allowHosts(),
    ask: async () => {
      asking.resolve();
      return answer.promise;
    },
  };
  const { service, browser, ctx } = setUp(t, { approvals });
  const opened = service.execute('chrome.open', { url: 'http://acme.example.test/' }, ctx);
  await asking.promise;

  await service.closeAll();
  answer.resolve('once');

  await assert.rejects(opened, refusal(409, 'The Mittr account changed'));
  assert.equal(browser.commands().some(([command]) => command === 'open'), false);
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
  await assert.rejects(service.execute('chrome.do', { goal: 'x' }, ctx), refusal(503, 'chrome.do needs the Mittr platform; ask the user to sign in to Mittr, or work step by step with chrome.snapshot'));
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
  assert.equal(optionOf(browser.calls.at(-1), '--session'), SES_1);
});

test('chrome.close and a deleted session close only a Chrome that is running, and forget the session\'s grants', async (t) => {
  const browser = fakeBrowser({ running: [chromeSessionName('ses_old')] });
  const { service, approvals, ctx } = setUp(t, { browser });
  assert.deepEqual(await service.execute('chrome.close', {}, ctx), { closed: true });
  assert.deepEqual(browser.commands(), [['session', 'list']], 'nothing is launched to close a Chrome that never ran');

  await service.execute('chrome.open', { url: 'https://acme.example.test/' }, ctx);
  service.allowForConversation('ses_1');
  await service.closeSession('ses_1');
  assert.deepEqual(browser.commands().at(-1), ['close']);
  assert.equal(optionOf(browser.calls.at(-1), '--session'), SES_1);
  assert.equal(await service.isHostAllowed('ses_1', 'other.example.test'), false);
  assert.deepEqual(approvals.record.forgotten, ['ses_1', 'ses_1']);

  await service.closeSession('ses_old');
  assert.equal(optionOf(browser.calls.at(-1), '--session'), chromeSessionName('ses_old'), 'a Chrome left from an earlier run is closed too');
  await service.closeSession('');
});

test('a conversation grant allows every host for that session until the conversation ends', async (t) => {
  const { service, approvals } = setUp(t, { approvals: allowHosts('acme.example.test') });
  assert.equal(await service.isHostAllowed('ses_1', 'other.example.test', 'voice'), false);
  service.allowForConversation('ses_1');
  assert.equal(await service.isHostAllowed('ses_1', 'other.example.test', 'voice'), true);
  assert.equal(await service.isHostAllowed('ses_1', 'other.example.test', 'http'), false);
  assert.equal(await service.isHostAllowed('ses_1', 'other.example.test', 'agent'), false);
  assert.equal(await service.isHostAllowed('ses_2', 'other.example.test', 'voice'), false);
  assert.equal(await service.isHostAllowed('ses_2', 'acme.example.test'), true);
  service.endConversation('ses_1');
  assert.equal(await service.isHostAllowed('ses_1', 'other.example.test', 'voice'), false);
  assert.deepEqual(approvals.record.forgotten, ['ses_1']);

  service.allowForConversation('ses_3');
  service.forgetEveryGrant();
  assert.equal(await service.isHostAllowed('ses_3', 'other.example.test', 'voice'), false);
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
  const verbatim = "Use a Chrome session that starts from the user's own Chrome profile, for sites the user is already signed in to in Chrome (Plane, Jira, internal tools) and for web work that should not take over MittrCraft's browser panel. To look at the app being built, use openchamber_web instead. Use one action per call: chrome.open a page, then either chrome.do with the goal to let MittrCraft work through the page step by step on its own (fastest for filling forms and clicking through flows), or chrome.snapshot to get refs and act on them yourself. If chrome.do stops to ask, ask the user; do not guess. The first time you open a site the user is asked whether you may use their sign-in there. If a page asks you to sign in, stop and tell the user which site — never type a password or fill a sign-in form.";
  assert.equal(chromeToolDescription({ webTool: true, doTask: true }), verbatim);
  for (const options of [{}, { webTool: true }, { doTask: true }]) {
    assert.ok(chromeToolDescription(options).endsWith('If a page asks you to sign in, stop and tell the user which site — never type a password or fill a sign-in form.'), JSON.stringify(options));
  }
});

test('the description names chrome.do only once it exists, and openchamber_web only while that tool is on', () => {
  assert.equal(chromeToolDescription(), "Use a Chrome session that starts from the user's own Chrome profile, for sites the user is already signed in to in Chrome (Plane, Jira, internal tools) and for web work that should not take over MittrCraft's browser panel. Use one action per call: chrome.open a page, then chrome.snapshot to get refs and act on them yourself. The first time you open a site the user is asked whether you may use their sign-in there. If a page asks you to sign in, stop and tell the user which site — never type a password or fill a sign-in form.");
  assert.match(chromeToolDescription({ webTool: true }), /To look at the app being built, use openchamber_web instead\./);
  assert.doesNotMatch(chromeToolDescription({ webTool: true }), /chrome\.do/);
  assert.doesNotMatch(chromeToolDescription({ doTask: true }), /openchamber_web/);
});

test('the Chrome actions are registered on mittrcraft_chrome, with their effects', (t) => {
  const registry = createMittrActionRegistry({ control: { all: OPENCHAMBER_ALL_ACTIONS, execute: async () => ({}) } });
  const { service } = setUp(t);
  const offered = { value: true };
  const doTask = { value: false };
  registerChromeActions(registry, { service, available: () => offered.value, doTask: () => doTask.value });
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
    ['chrome.do', 'change'],
    ['chrome.close', 'change'],
  ]);
  const [tool] = registry.tools();
  assert.equal(tool.description, chromeToolDescription());
  assert.deepEqual(Object.keys(tool.parameters), ['url', 'ref', 'value', 'key', 'text', 'selector', 'label', 'goal', 'maxSteps']);
  assert.deepEqual(tool.definitions.map(({ action }) => action).includes('chrome.do'), false, 'chrome.do is offered only while it can run');
  doTask.value = true;
  assert.deepEqual(registry.tools()[0].definitions.at(-2), {
    action: 'chrome.do',
    title: 'Do a task on the Chrome page',
    description: 'Give goal in plain words and MittrCraft works through the open page on its own, one step at a time (click, fill, choose), until the goal is done, it needs to ask the user, or maxSteps runs out. Returns every step it took and where it stopped. chrome.open the page first',
  });
  offered.value = false;
  assert.deepEqual(registry.tools(), []);
});

test('the chrome.do parameters are offered only with chrome.do', () => {
  assert.deepEqual(Object.keys(chromeToolParameters({ doTask: false })), ['url', 'ref', 'value', 'key', 'text', 'selector', 'label']);
  assert.deepEqual(chromeToolParameters({ doTask: true }).goal, { type: 'string', description: 'For chrome.do: what to get done on the open page, in the user\'s own words and with every value it needs' });
  assert.deepEqual(chromeToolParameters({ doTask: true }).maxSteps, { type: 'integer', minimum: 1, maximum: 40, description: 'For chrome.do: most steps to take before stopping (default 15)' });
});

const pinnable = (fake) => Object.assign(fake, { begins: 0, begin: () => {
  fake.begins += 1;
  return { nextStep: (...args) => fake.nextStep(...args) };
} });

const stepperOf = (replies) => {
  const calls = [];
  return pinnable({
    calls,
    nextStep: async (body, signal) => {
      calls.push({ ...structuredClone(body), aborted: signal?.aborted === true });
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  });
};

const reply = (step, extra = {}) => ({ step, decidedBy: ['jev'], ms: 12, ...extra });
const FILL_NAME = reply({ action: 'fill', ref: 'e1', target: 'textbox "Name"', value: 'Somchai' }, { values: ['Somchai'] });
const CLICK_SEND = reply({ action: 'click', ref: 'e2', target: 'button "Send"' });
const FILLED = { step: 'fill textbox "Name" = "Somchai"', decidedBy: ['jev'], ms: 12 };
const SENT = { step: 'click button "Send"', decidedBy: ['jev'], ms: 12 };

const doSetUp = async (t, { replies = [], stepper = stepperOf(replies), ...options } = {}) => {
  const setup = setUp(t, { stepper, ...options });
  await setup.service.execute('chrome.open', { url: 'https://acme.example.test/form' }, setup.ctx);
  const opened = setup.browser.calls.length;
  const since = () => setup.browser.commands().slice(opened);
  return { ...setup, stepper, since };
};

test('a form goal fills the name, submits and ends done with every step listed', async (t) => {
  const { service, ctx, stepper, since } = await doSetUp(t, { browser: fakeBrowser({ clickTo: 'https://acme.example.test/sent' }), replies: [FILL_NAME, CLICK_SEND, reply({ action: 'done' })] });
  assert.deepEqual(await service.execute('chrome.do', { goal: 'Send the form as Somchai' }, ctx), { outcome: 'done', steps: [FILLED, SENT], url: 'https://acme.example.test/sent' });
  assert.deepEqual(since().map(([command]) => command), [
    'get',
    'get', 'snapshot', 'get', 'get', 'fill', 'get',
    'get', 'snapshot', 'get', 'get', 'click', 'get',
    'get', 'snapshot', 'get',
    'get',
  ], 'every snapshot and step is checked before and after it, like a direct call');
  assert.equal(stepper.begins, 1, 'the account is pinned once, when chrome.do starts');
  assert.deepEqual(since().filter(([command]) => command === 'fill' || command === 'click'), [['fill', '@e1', 'Somchai'], ['click', '@e2']]);
  assert.deepEqual(stepper.calls.map(({ goal, snapshot, history, values }) => ({ goal, snapshot, history, values })), [
    { goal: 'Send the form as Somchai', snapshot: '- textbox "Name" [ref=e1]\n- button "Send" [ref=e2]', history: [], values: undefined },
    { goal: 'Send the form as Somchai', snapshot: '- textbox "Name" [ref=e1]\n- button "Send" [ref=e2]', history: ['fill textbox "Name" = "Somchai"'], values: ['Somchai'] },
    { goal: 'Send the form as Somchai', snapshot: '- textbox "Name" [ref=e1]\n- button "Send" [ref=e2]', history: ['fill textbox "Name" = "Somchai"', 'click button "Send"'], values: ['Somchai'] },
  ]);
});

test('a goal missing a value stops with the platform\'s question', async (t) => {
  const { service, ctx, since } = await doSetUp(t, { replies: [reply({ action: 'ask', question: 'What should go in textbox "Name"?' })] });
  assert.deepEqual(await service.execute('chrome.do', { goal: 'Send the form' }, ctx), { outcome: 'ask', question: 'What should go in textbox "Name"?', steps: [], url: 'https://acme.example.test/form' });
  assert.equal(since().some(([command]) => command === 'fill' || command === 'click'), false);
});

test('a stop from the platform ends stopped with its reason', async (t) => {
  const { service, ctx } = await doSetUp(t, { replies: [FILL_NAME, reply({ action: 'stop', reason: 'the page asks for a payment' })] });
  assert.deepEqual(await service.execute('chrome.do', { goal: 'Send the form as Somchai' }, ctx), { outcome: 'stopped', reason: 'the page asks for a payment', steps: [FILLED], url: 'https://acme.example.test/form' });
});

test('the same step three times stops as stuck', async (t) => {
  const { service, ctx, since } = await doSetUp(t, { replies: [CLICK_SEND, CLICK_SEND, CLICK_SEND, reply({ action: 'done' })] });
  assert.deepEqual(await service.execute('chrome.do', { goal: 'Send it' }, ctx), {
    outcome: 'stuck',
    reason: 'the same step was chosen three times: click button "Send"',
    steps: [SENT, SENT],
    url: 'https://acme.example.test/form',
  });
  assert.equal(since().filter(([command]) => command === 'click').length, 2);
});

const endless = () => {
  const calls = [];
  return pinnable({
    calls,
    nextStep: async (body) => {
      calls.push(body);
      return reply({ action: 'click', ref: `e${calls.length}`, target: `link "${calls.length}"` });
    },
  });
};

test('maxSteps 50 is capped at 40', async (t) => {
  for (const [maxSteps, limit] of [[50, 40], [undefined, 15], [2, 2], [0, 15], ['3', 3], [2.5, 15]]) {
    const { service, ctx, stepper } = await doSetUp(t, { stepper: endless() });
    const result = await service.execute('chrome.do', { goal: 'Click around', maxSteps }, ctx);
    assert.equal(result.outcome, 'step_limit', String(maxSteps));
    assert.equal(result.reason, `stopped after ${limit} steps`);
    assert.equal(result.steps.length, limit);
    assert.equal(stepper.calls.length, limit);
  }
});

const platformStepper = (respond) => {
  const fetchImpl = fakeFetch(respond);
  const stepper = createBrowserStepper({ broker: { baseUrl: 'https://platform.example.test' }, ensureFreshSession: async () => ({ accessToken: 'at-1' }), fetchImpl, engineOnActiveHome: () => true, activeAccountKey: () => null });
  return { stepper, fetchImpl };
};

test('a platform 503 ends as stopped and keeps the steps taken', async (t) => {
  const { stepper } = platformStepper((_call, count) => (count === 1
    ? json({ step: { action: 'fill', ref: 'e1', target: 'textbox "Name"', value: 'Somchai' }, decidedBy: ['jev'], ms: 12 })
    : json({ message: 'The decision model is resting' }, 503)));
  const { service, ctx } = await doSetUp(t, { stepper });
  assert.deepEqual(await service.execute('chrome.do', { goal: 'Send the form as Somchai' }, ctx), { outcome: 'stopped', reason: 'The decision model is resting', steps: [FILLED], url: 'https://acme.example.test/form' });
});

test('a chrome.do step that leaves the host stops with site_moved and keeps the steps taken', async (t) => {
  const { service, ctx, stepper, since } = await doSetUp(t, { browser: fakeBrowser({ clickTo: 'https://evil.example.test/inbox?id=7' }), replies: [FILL_NAME, CLICK_SEND, reply({ action: 'done' })] });
  const result = await service.execute('chrome.do', { goal: 'Send the form as Somchai' }, ctx);
  assert.deepEqual(result, {
    outcome: 'stopped',
    reason: 'The page moved to evil.example.test, which the user has not allowed; nothing from it is returned. Call chrome.open with that page\'s URL to ask the user',
    code: 'site_moved',
    host: 'evil.example.test',
    steps: [FILLED, SENT],
    url: null,
  });
  assert.equal(stepper.calls.length, 2, 'nothing from the new host is sent to the platform');
  assert.equal(since().filter(([command]) => command === 'snapshot').length, 2);
  assert.equal(JSON.stringify(result).includes('inbox'), false);
});

test('a step without a ref is not run', async (t) => {
  const { stepper } = platformStepper(() => json({ step: { action: 'click', target: 'button "Send"' } }));
  const checked = await doSetUp(t, { stepper });
  assert.deepEqual(await checked.service.execute('chrome.do', { goal: 'Send it' }, checked.ctx), { outcome: 'stopped', reason: 'The Mittr platform returned no usable step', steps: [], url: 'https://acme.example.test/form' });
  assert.equal(checked.since().some(([command]) => command === 'click'), false);

  const unchecked = await doSetUp(t, { replies: [FILL_NAME, reply({ action: 'click', target: 'button "Send"' })] });
  const result = await unchecked.service.execute('chrome.do', { goal: 'Send it' }, unchecked.ctx);
  assert.deepEqual(result, { outcome: 'stopped', reason: 'ref must be an element ref from chrome.snapshot, such as @e3', steps: [FILLED], url: 'https://acme.example.test/form' });
  assert.equal(unchecked.since().some(([command]) => command === 'click'), false);

  const first = await doSetUp(t, { replies: [reply({ action: 'click', target: 'button "Send"' })] });
  await assert.rejects(first.service.execute('chrome.do', { goal: 'Send it' }, first.ctx), refusal(400, 'ref must be an element ref from chrome.snapshot, such as @e3'));
  assert.equal(first.since().some(([command]) => command === 'click'), false);
});

test('a step value that looks like a driver flag is refused, not run, and a refusal before any step reaches the agent itself', async (t) => {
  const { service, ctx, since } = await doSetUp(t, { replies: [reply({ action: 'fill', ref: 'e1', target: 'textbox "Name"', value: '--headed' })] });
  await assert.rejects(service.execute('chrome.do', { goal: 'Fill it' }, ctx), refusal(400, 'value cannot start with "-"'));
  assert.equal(since().some(([command]) => command === 'fill'), false);

  const later = await doSetUp(t, { replies: [CLICK_SEND, reply({ action: 'fill', ref: 'e1', target: 'textbox "Name"', value: '-x' })] });
  assert.deepEqual(await later.service.execute('chrome.do', { goal: 'Fill it' }, later.ctx), { outcome: 'stopped', reason: 'value cannot start with "-"', steps: [SENT], url: 'https://acme.example.test/form' });
  assert.equal(later.since().some(([command]) => command === 'fill'), false);
});

test('a site the person withdraws during chrome.do raises the question again before the next step', async (t) => {
  const allowed = new Set(['acme.example.test']);
  const asks = [];
  const approvals = {
    isApproved: async (_sessionId, host) => allowed.has(host),
    ask: async ({ sessionId, host }) => {
      asks.push({ sessionId, host });
      return 'reject';
    },
    forgetSession: () => {},
    forgetAll: () => {},
    removeHost: async () => [],
  };
  const stepper = stepperOf([FILL_NAME, CLICK_SEND]);
  const fill = stepper.nextStep;
  stepper.nextStep = async (body, signal) => {
    const answer = await fill(body, signal);
    if (stepper.calls.length === 2) allowed.delete('acme.example.test');
    return answer;
  };
  const { service, ctx, since } = await doSetUp(t, { approvals, stepper });
  assert.deepEqual(await service.execute('chrome.do', { goal: 'Send the form as Somchai' }, ctx), { outcome: 'stopped', reason: 'The user did not allow using their Chrome sign-in on acme.example.test', steps: [FILLED], url: null });
  assert.deepEqual(asks, [{ sessionId: 'ses_1', host: 'acme.example.test' }]);
  assert.equal(since().some(([command]) => command === 'click'), false);
});

test('chrome.do asks first about a page not yet allowed, and refuses MittrCraft itself before asking the platform', async (t) => {
  const approvals = allowHosts();
  const stepper = stepperOf([reply({ action: 'done' })]);
  const { service, browser, ctx } = setUp(t, { approvals, stepper });
  browser.urls.set(SES_1, 'https://acme.example.test/x');
  await assert.rejects(service.execute('chrome.do', { goal: 'Send it' }, ctx), refusal(403, 'The user did not allow using their Chrome sign-in on acme.example.test'));
  assert.deepEqual(approvals.record.asks.map(({ host }) => host), ['acme.example.test']);
  browser.urls.set(SES_1, 'http://127.0.0.1:4100/api/config');
  await assert.rejects(service.execute('chrome.do', { goal: 'Send it' }, ctx), refusal(400, 'That address is MittrCraft itself'));
  assert.equal(stepper.calls.length, 0);
  assert.equal(browser.commands().some(([command]) => command === 'snapshot'), false);
});

test('chrome.do needs a goal and an open page', async (t) => {
  const stepper = stepperOf([]);
  const { service, browser, ctx } = setUp(t, { stepper });
  await assert.rejects(service.execute('chrome.do', {}, ctx), refusal(400, 'goal is required'));
  await assert.rejects(service.execute('chrome.do', { goal: 'g'.repeat(4_001) }, ctx), refusal(400, 'goal is too long for chrome.do; say it in at most 4000 characters'));
  await assert.rejects(service.execute('chrome.do', { goal: 'Send it' }, ctx), refusal(400, 'No page is open in this session; call chrome.open first'));
  assert.deepEqual(browser.commands(), [['session', 'list']]);
  assert.equal(stepper.calls.length, 0);
});

test('a chrome.do whose Chrome is closed while the platform chooses a step clicks nothing and keeps no session', async (t) => {
  const choosing = deferred();
  const chosen = deferred();
  const stepper = pinnable({
    nextStep: async () => {
      choosing.resolve();
      return chosen.promise;
    },
  });
  const { service, ctx, browser, since } = await doSetUp(t, { stepper });
  const doing = service.execute('chrome.do', { goal: 'Send the form' }, ctx);
  await choosing.promise;

  await service.closeAll();
  chosen.resolve(CLICK_SEND);

  await assert.rejects(doing, refusal(409, 'The Mittr account changed'));
  assert.equal(since().some(([command]) => command === 'click'), false);
  assert.equal(browser.urls.has(SES_1), false);
});

test('a chrome.do whose snapshot is running when Chrome is closed ends with the account change and keeps no session', async (t) => {
  const base = fakeBrowser();
  const snapshotting = deferred();
  const release = deferred();
  const gate = { armed: false };
  const browser = {
    ...base,
    execute: async (binary, argv, options) => {
      if (gate.armed && commandOf(argv)[0] === 'snapshot') {
        snapshotting.resolve();
        await release.promise;
      }
      return base.execute(binary, argv, options);
    },
  };
  const { service, ctx, since, stepper } = await doSetUp(t, { browser, replies: [CLICK_SEND] });
  gate.armed = true;
  const doing = service.execute('chrome.do', { goal: 'Send the form' }, ctx);
  await snapshotting.promise;

  await service.closeAll();
  release.resolve();

  await assert.rejects(doing, refusal(409, 'The Mittr account changed'));
  assert.deepEqual(since().slice(-3), [['close', '--all'], ['snapshot', '-i'], ['close']]);
  assert.equal(base.urls.has(SES_1), false);
  assert.equal(stepper.calls.length, 0, 'the page read across the close is not sent to the platform');
});

test('a chrome.do cancelled between steps stops and reads nothing more', async (t) => {
  const controller = new AbortController();
  const stepper = stepperOf([FILL_NAME, CLICK_SEND]);
  const fill = stepper.nextStep;
  stepper.nextStep = async (body, signal) => {
    const answer = await fill(body, signal);
    controller.abort();
    return answer;
  };
  const { service, ctx, since } = await doSetUp(t, { stepper });
  const result = await service.execute('chrome.do', { goal: 'Send the form as Somchai' }, { ...ctx, signal: controller.signal });
  assert.deepEqual(result, { outcome: 'stopped', reason: 'the call was cancelled', steps: [], url: null });
  assert.equal(stepper.calls.length, 1);
  assert.deepEqual(since().map(([command]) => command), ['get', 'get', 'snapshot', 'get']);
});

const VOICE = chromeSessionName('voice');

test('a voice chrome call on a new site answers site_approval_required with the host and raises no card', async (t) => {
  const approvals = allowHosts();
  const { service, browser, ctx } = setUp(t, { approvals });
  const voice = { ...ctx, sessionId: 'voice', surface: 'voice' };
  const notYet = refusal(403, 'The user has not yet allowed using their Chrome sign-in on acme.example.test', { code: 'site_approval_required', host: 'acme.example.test' });

  await assert.rejects(service.execute('chrome.open', { url: 'https://acme.example.test/x' }, voice), notYet);
  browser.urls.set(VOICE, 'https://acme.example.test/y');
  await assert.rejects(service.execute('chrome.read', {}, voice), notYet);

  assert.deepEqual(approvals.record.asks, []);
  assert.equal(browser.commands().some(([command]) => command === 'open' || command === 'read'), false);
});

test('an always-allowed site opens from voice with no question', async (t) => {
  const approvals = allowHosts('acme.example.test');
  const { service, browser, ctx } = setUp(t, { approvals });
  await service.execute('chrome.open', { url: 'https://acme.example.test/x' }, { ...ctx, sessionId: 'voice', surface: 'voice' });
  assert.deepEqual(approvals.record.asks, []);
  assert.equal(browser.urls.get(VOICE), 'https://acme.example.test/x');
});

test('removing a site in Settings ends the voice conversation\'s Chrome allow', async (t) => {
  const { service } = setUp(t, { approvals: allowHosts('acme.example.test') });
  service.allowForConversation('voice');
  assert.equal(await service.isHostAllowed('voice', 'other.example.test', 'voice'), true);
  await service.removeHost('acme.example.test');
  assert.equal(await service.isHostAllowed('voice', 'other.example.test', 'voice'), false);
});

test('a call begun while closeAll runs waits and starts in the new generation', async (t) => {
  const base = fakeBrowser();
  const closing = deferred();
  const release = deferred();
  const browser = {
    ...base,
    execute: async (binary, argv, options) => {
      if (commandOf(argv).join(' ') === 'close --all') {
        closing.resolve();
        await release.promise;
      }
      return base.execute(binary, argv, options);
    },
  };
  const { service, ctx } = setUp(t, { browser });
  const closed = service.closeAll();
  await closing.promise;
  const opened = service.execute('chrome.open', { url: 'http://acme.example.test/' }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(base.commands(), []);

  release.resolve();
  await closed;
  await opened;
  assert.deepEqual(base.commands().slice(0, 3), [['close', '--all'], ['profiles'], ['open', 'http://acme.example.test/']]);
  assert.equal(base.urls.get(SES_1), 'http://acme.example.test/');
});

test('currentPage answers null for a session this server never opened and runs no command', async (t) => {
  const { service, browser, ctx } = setUp(t);
  browser.urls.set(VOICE, 'https://acme.example.test/elsewhere');
  assert.equal(await service.currentPage('voice'), null);
  assert.deepEqual(browser.calls, []);

  await service.execute('chrome.open', { url: 'https://acme.example.test/x' }, { ...ctx, sessionId: 'voice', surface: 'voice' });
  const before = browser.calls.length;
  assert.deepEqual(await service.currentPage('voice'), { url: 'https://acme.example.test/x', title: 'Acme home' });
  assert.deepEqual(browser.commands().slice(before), [['get', 'url'], ['get', 'title']]);

  await service.closeAll();
  const afterClose = browser.calls.length;
  assert.equal(await service.currentPage('voice'), null);
  assert.equal(browser.calls.length, afterClose);
});

test('no route, plugin tool or http surface reaches allowForConversation', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const writers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') && /\ballowForConversation\b/.test(fs.readFileSync(file, 'utf8'))) {
        writers.push(path.relative(root, file).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  assert.ok(writers.includes('mittr/tools/chrome-service.js'));
  assert.deepEqual(writers.filter((file) => file !== 'mittr/tools/chrome-service.js' && file !== 'mittr/voice/actions.js'), []);
});

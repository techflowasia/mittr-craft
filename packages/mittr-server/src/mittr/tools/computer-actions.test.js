import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MARKER_PNG } from '../../../../../scripts/mittr/probe-tool-plugin.mjs';
import { OPENCHAMBER_ALL_ACTIONS } from '../../../../web/server/lib/openchamber-control/actions.js';
import { writeScreenshot } from '../../../../web/server/lib/openchamber-control/screenshots.js';
import { SCREEN_RECORDING_NOT_GRANTED, stubCuaDriver, stubCuaDriverCalls, tempDataDir } from '../test-helpers.js';
import { APP_NAME_PATTERN, COMPUTER_TOOL_DESCRIPTION, TURNED_OFF_MID_ACTION, registerComputerActions } from './computer-actions.js';
import { DRIVER_STOPPED, createComputerControl, createDriverDaemon } from './computer-control.js';
import { MITTR_TOOLS, MittrToolError, createMittrActionRegistry } from './registry.js';
import { MAX_IMAGE_BYTES } from './screenshots.js';

const ACCESSIBILITY_NOT_GRANTED = 'Accessibility is NOT granted for this process.';
const GRANT_COMMAND_ONLY = 'run `cua-driver permissions grant` to request and verify it explicitly.';

const setUp = ({ available = true, offered = () => true, answers = {}, launchApp = async () => {}, save = writeScreenshot, logger = { warn: () => {} } } = {}) => {
  const registry = createMittrActionRegistry({ control: { all: OPENCHAMBER_ALL_ACTIONS, execute: async () => ({}) } });
  const requests = [];
  const control = {
    available,
    request: async (tool, args, options) => {
      requests.push({ tool, args, options });
      const answer = answers[tool];
      if (answer instanceof Error) throw answer;
      return answer instanceof Function ? answer(args) : answer;
    },
  };
  registerComputerActions(registry, { control, launchApp, writeScreenshot: save, offered, logger });
  const run = (action, input = {}, ctx = {}) => registry.execute(action, input, { surface: 'agent', tool: MITTR_TOOLS.computer, ...ctx });
  return { registry, requests, run };
};

const refusedWith = (status, message) => (error) => {
  assert.ok(error instanceof MittrToolError, String(error));
  assert.equal(error.statusCode, status);
  assert.equal(error.message, message);
  return true;
};

test('the computer tool carries 1.22\'s description, titles and app parameter', () => {
  const { registry } = setUp();
  const [tool] = registry.tools();
  assert.equal(tool.name, 'mittrcraft_computer');
  assert.equal(tool.description, COMPUTER_TOOL_DESCRIPTION);
  assert.ok(COMPUTER_TOOL_DESCRIPTION.startsWith("Look at and act on the user's whole desktop, not just MittrCraft's own panels"));
  assert.ok(COMPUTER_TOOL_DESCRIPTION.includes('computer.screenshot to see the current desktop — the image is attached to the result for you to read directly when it is small enough to attach (the result says if it is not; then it is only saved as a file), so there is no need to open it with a file-reading tool.'));
  assert.equal(registry.definitions({ tool: MITTR_TOOLS.computer }).at(-1).description, 'Screenshot the whole desktop and see it directly when the image is small enough to attach; it is also saved as a file in the project whose path is returned; no parameters');
  assert.deepEqual(Object.keys(tool.parameters), ['app']);
  assert.deepEqual(registry.definitions({ tool: MITTR_TOOLS.computer }).map(({ action, title, effect }) => [action, title, effect]), [
    ['computer.list_apps', 'List desktop apps', 'read'],
    ['computer.open_app', 'Open an app', 'change'],
    ['computer.bring_to_front', 'Bring an app to the front', 'change'],
    ['computer.screenshot', 'Screenshot the desktop', 'read'],
  ]);
});

test('list_apps maps the driver\'s fields', async () => {
  const { run, requests } = setUp({
    answers: {
      list_apps: { apps: [
        { name: 'Calculator', pid: 501, running: true, bundle_id: 'com.apple.calculator', extra: 1 },
        { name: 'Notes', pid: 0, running: false },
        { name: 'Odd', pid: 9, running: 'yes', bundle_id: null },
      ] },
    },
  });
  assert.deepEqual(await run('computer.list_apps'), {
    apps: [
      { name: 'Calculator', pid: 501, running: true, bundleId: 'com.apple.calculator' },
      { name: 'Notes', pid: 0, running: false, bundleId: null },
      { name: 'Odd', pid: 9, running: false, bundleId: null },
    ],
  });
  assert.deepEqual(requests.map(({ tool }) => tool), ['list_apps']);
});

test('list_apps answers no apps when the driver lists none', async () => {
  assert.deepEqual(await setUp({ answers: { list_apps: {} } }).run('computer.list_apps'), { apps: [] });
});

test('an app name outside the plain-name pattern is refused before open runs', async () => {
  const opened = [];
  const { run } = setUp({ launchApp: async (name) => opened.push(name) });
  for (const app of ['Calc; rm -rf ~', '../x', '-a', 'a'.repeat(81), ' -a', '$(id)', 'Calc\nulator', '.', '..', '...', '.hidden', '()&', '- -']) {
    await assert.rejects(run('computer.open_app', { app }), refusedWith(400, 'app must be a plain app name'), JSON.stringify(app));
  }
  for (const app of [undefined, '', '   ', 7]) {
    await assert.rejects(run('computer.open_app', { app }), refusedWith(400, 'app is required for computer.open_app'), JSON.stringify(app));
  }
  assert.deepEqual(opened, []);
  assert.equal(APP_NAME_PATTERN.test('a'.repeat(80)), true);
});

test('open_app opens the named app and says so', async () => {
  const opened = [];
  const { run, requests } = setUp({ launchApp: async (name) => opened.push(name) });
  assert.deepEqual(await run('computer.open_app', { app: '  Visual Studio Code (Insiders) & Co  ' }), { launched: true, app: 'Visual Studio Code (Insiders) & Co' });
  assert.deepEqual(opened, ['Visual Studio Code (Insiders) & Co']);
  assert.deepEqual(requests, [], 'opening an app needs no driver');
});

test('an app open cannot launch answers 502 with open\'s words', async () => {
  const { run } = setUp({ launchApp: async () => { throw new Error('Unable to find application named \'Nope\''); } });
  await assert.rejects(run('computer.open_app', { app: 'Nope' }), refusedWith(502, 'Could not open "Nope": Unable to find application named \'Nope\''));
});

test('bring_to_front finds the running app by name in any case and activates it', async () => {
  const { run, requests } = setUp({
    answers: {
      list_apps: { apps: [{ name: 'Calculator', pid: 3, running: false }, { name: 'Calculator', pid: 4, running: true }] },
      bring_to_front: { process_activated: true, exact_window_effect: { verified: true } },
    },
  });
  assert.deepEqual(await run('computer.bring_to_front', { app: 'calculator' }), { activated: true, windowVerified: true });
  assert.deepEqual(requests.map(({ tool, args }) => [tool, args]), [['list_apps', {}], ['bring_to_front', { pid: 4 }]]);
});

test('bring_to_front reports an unverified window as not verified', async () => {
  const { run } = setUp({ answers: { list_apps: { apps: [{ name: 'Notes', pid: 4, running: true }] }, bring_to_front: { process_activated: true } } });
  assert.deepEqual(await run('computer.bring_to_front', { app: 'Notes' }), { activated: true, windowVerified: false });
});

const CALCULATOR_WINDOWS = [
  { window_id: 3965, title: 'Calculator' },
  { window_id: 3964, title: '' },
  { window_id: 3963, title: null },
  { window_id: 3962 },
  { window_id: 3961, title: '   ' },
];

const severalWindows = (candidates, picked = { process_activated: true, exact_window_effect: { verified: true } }) => (args) => (
  args.window_id === undefined ? { code: 'ambiguous_window_target', candidates } : picked
);

test('bring_to_front picks the titled main window when the app also has untitled helper windows', async () => {
  const { run, requests } = setUp({
    answers: {
      list_apps: { apps: [{ name: 'Calculator', pid: 55452, running: true }] },
      bring_to_front: severalWindows(CALCULATOR_WINDOWS),
    },
  });
  assert.deepEqual(await run('computer.bring_to_front', { app: 'Calculator' }), {
    activated: true,
    windowVerified: true,
    window: { windowId: 3965, title: 'Calculator' },
  });
  assert.deepEqual(requests.map(({ tool, args }) => [tool, args]), [
    ['list_apps', {}],
    ['bring_to_front', { pid: 55452 }],
    ['bring_to_front', { pid: 55452, window_id: 3965 }],
  ]);
});

test('bring_to_front prefers the window titled with the app\'s name, then the first titled one', async () => {
  const named = setUp({
    answers: {
      list_apps: { apps: [{ name: 'Finder', pid: 4, running: true }] },
      bring_to_front: severalWindows([{ window_id: 11, title: 'Downloads' }, { window_id: 12, title: '' }, { window_id: 13, title: 'finder' }]),
    },
  });
  assert.deepEqual((await named.run('computer.bring_to_front', { app: 'Finder' })).window, { windowId: 13, title: 'finder' });
  const first = setUp({
    answers: {
      list_apps: { apps: [{ name: 'Finder', pid: 4, running: true }] },
      bring_to_front: severalWindows([{ window_id: 12, title: '' }, { window_id: 11, title: 'Downloads' }, { window_id: 14, title: 'Documents' }]),
    },
  });
  assert.deepEqual((await first.run('computer.bring_to_front', { app: 'Finder' })).window, { windowId: 11, title: 'Downloads' });
});

test('the chosen window must be verified as the one in front, or the action answers the plain failure', async () => {
  const { run } = setUp({
    answers: {
      list_apps: { apps: [{ name: 'Calculator', pid: 55452, running: true }] },
      bring_to_front: severalWindows(CALCULATOR_WINDOWS, { process_activated: true, exact_window_effect: { verified: false } }),
    },
  });
  await assert.rejects(run('computer.bring_to_front', { app: 'Calculator' }), refusedWith(502, 'Could not bring Calculator to the front.'));
});

test('the driver\'s reason behind the plain failure is logged on the server', async () => {
  const warnings = [];
  const reason = 'bring_to_front: pid 55452, did not become frontmost (request_accepted=true)';
  const { run } = setUp({
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    answers: { list_apps: { apps: [{ name: 'Calculator', pid: 55452, running: true }] }, bring_to_front: new Error(reason) },
  });
  await assert.rejects(run('computer.bring_to_front', { app: 'Calculator' }), refusedWith(502, 'Could not bring Calculator to the front.'));
  assert.deepEqual(warnings, [`[mittr] computer.bring_to_front did not bring Calculator forward: ${reason}`]);
  const unverified = [];
  const quiet = setUp({
    logger: { warn: (...args) => unverified.push(args.join(' ')) },
    answers: { list_apps: { apps: [{ name: 'Calculator', pid: 55452, running: true }] }, bring_to_front: { process_activated: false } },
  });
  await assert.rejects(quiet.run('computer.bring_to_front', { app: 'Calculator' }), refusedWith(502, 'Could not bring Calculator to the front.'));
  assert.deepEqual(unverified, ['[mittr] computer.bring_to_front did not bring Calculator forward: the app was not activated']);
});

test('bring_to_front with only untitled windows refuses in a plain sentence and sends nothing more', async () => {
  const { run, requests } = setUp({
    answers: {
      list_apps: { apps: [{ name: 'Calculator', pid: 55452, running: true }] },
      bring_to_front: severalWindows(CALCULATOR_WINDOWS.slice(1)),
    },
  });
  await assert.rejects(
    run('computer.bring_to_front', { app: 'calculator' }),
    refusedWith(409, 'Could not bring Calculator to the front: it has several windows and none of them has a title to pick it by.'),
  );
  assert.deepEqual(requests.map(({ tool }) => tool), ['list_apps', 'bring_to_front']);
});

test('bring_to_front never answers ok when nothing came to the front', async () => {
  const notActivated = [
    { process_activated: false },
    {},
    null,
    severalWindows(CALCULATOR_WINDOWS, { process_activated: false }),
    severalWindows(CALCULATOR_WINDOWS, { code: 'ambiguous_window_target', candidates: CALCULATOR_WINDOWS }),
    severalWindows(CALCULATOR_WINDOWS, new Error('bring_to_front: exact window 3965 for pid 55452 was not verified as frontmost and focused (request_accepted=true, process_activated=false)')),
    new Error('bring_to_front: pid 55452, did not become frontmost (request_accepted=true)'),
  ];
  for (const answer of notActivated) {
    const bringToFront = answer instanceof Function
      ? (args) => {
        const reply = answer(args);
        if (reply instanceof Error) throw reply;
        return reply;
      }
      : answer;
    const { run } = setUp({ answers: { list_apps: { apps: [{ name: 'Calculator', pid: 55452, running: true }] }, bring_to_front: bringToFront } });
    await assert.rejects(run('computer.bring_to_front', { app: 'Calculator' }), refusedWith(502, 'Could not bring Calculator to the front.'), String(answer));
  }
});

test('bring_to_front refuses an app that is not running, or a name that is not plain', async () => {
  const { run, requests } = setUp({ answers: { list_apps: { apps: [{ name: 'Notes', pid: 4, running: false }] } } });
  await assert.rejects(run('computer.bring_to_front', { app: 'Notes' }), refusedWith(404, 'No running app named "Notes"'));
  await assert.rejects(run('computer.bring_to_front', { app: 'a/b' }), refusedWith(400, 'app must be a plain app name'));
  await assert.rejects(run('computer.bring_to_front', {}), refusedWith(400, 'app is required for computer.bring_to_front'));
  assert.deepEqual(requests.map(({ tool }) => tool), ['list_apps']);
});

test('a screenshot is saved as desktop-*.png and carries the image', async (t) => {
  const project = fs.realpathSync(tempDataDir(t));
  const { run, requests } = setUp({
    answers: { get_desktop_state: { screenshot_png_b64: MARKER_PNG, screenshot_mime_type: 'image/png', screen_width: 2, screen_height: 2 } },
  });
  const result = await run('computer.screenshot', { directory: '/somewhere/else' }, { directory: project });

  assert.match(result.path, /^\.openchamber\/screenshots\/desktop-[0-9T-]+\.png$/);
  assert.deepEqual(fs.readFileSync(path.join(project, result.path)), Buffer.from(MARKER_PNG, 'base64'));
  assert.deepEqual(result, {
    path: result.path,
    hint: `The image is attached for you to view directly; write ![](${result.path}) in your reply to also show it to the user.`,
    width: 2,
    height: 2,
    image: { base64: MARKER_PNG, mime: 'image/png' },
  });
  assert.equal(fs.existsSync('/somewhere/else'), false);
  assert.deepEqual(requests.map(({ tool }) => tool), ['get_desktop_state']);
});

test('a screenshot too large to attach does not say it is attached', async (t) => {
  const project = fs.realpathSync(tempDataDir(t));
  const large = Buffer.concat([Buffer.from(MARKER_PNG, 'base64'), Buffer.alloc(MAX_IMAGE_BYTES)]).toString('base64');
  const { run } = setUp({ answers: { get_desktop_state: { screenshot_png_b64: large } } });
  const result = await run('computer.screenshot', {}, { directory: project });
  assert.equal(result.hint, `Write ![](${result.path}) in your reply to show it to the user.`);
  assert.equal(result.width, null);
  assert.equal(result.height, null);
  assert.equal(result.image.mime, 'image/png');
});

test('a screenshot without a project directory takes no picture', async () => {
  const { run, requests } = setUp({ answers: { get_desktop_state: { screenshot_png_b64: MARKER_PNG } } });
  await assert.rejects(run('computer.screenshot', {}, {}), refusedWith(400, 'A project directory is required to save a screenshot'));
  assert.deepEqual(requests, []);
});

test('a screenshot the driver answers without an image saves nothing', async (t) => {
  const project = fs.realpathSync(tempDataDir(t));
  const { run } = setUp({ answers: { get_desktop_state: { screen_width: 2 } } });
  await assert.rejects(run('computer.screenshot', {}, { directory: project }), refusedWith(502, 'The desktop screenshot came back without an image'));
  assert.equal(fs.existsSync(path.join(project, '.openchamber')), false);
});

test('a missing Screen Recording grant names it and where to turn it on', async (t) => {
  const project = fs.realpathSync(tempDataDir(t));
  const message = 'MittrCraft needs the Screen Recording permission for CuaDriver. Turn it on in System Settings → Privacy & Security → Screen Recording.';
  for (const text of [SCREEN_RECORDING_NOT_GRANTED, 'screen recording permission not granted', GRANT_COMMAND_ONLY, 'Accessibility is granted. Screen Recording is NOT granted for this process.']) {
    const { run } = setUp({ answers: { get_desktop_state: new Error(text) } });
    await assert.rejects(run('computer.screenshot', {}, { directory: project }), refusedWith(403, message), text);
  }
});

test('a missing Accessibility grant names it and where to turn it on', async () => {
  const message = 'MittrCraft needs the Accessibility permission for CuaDriver. Turn it on in System Settings → Privacy & Security → Accessibility.';
  for (const text of [ACCESSIBILITY_NOT_GRANTED, 'Accessibility permission not granted', GRANT_COMMAND_ONLY]) {
    const listing = setUp({ answers: { list_apps: new Error(text) } });
    await assert.rejects(listing.run('computer.list_apps'), refusedWith(403, message), text);
  }
  const bringing = setUp({ answers: { list_apps: { apps: [{ name: 'Notes', pid: 4, running: true }] }, bring_to_front: new Error(ACCESSIBILITY_NOT_GRANTED) } });
  await assert.rejects(bringing.run('computer.bring_to_front', { app: 'Notes' }), refusedWith(403, message));
});

test('a driver error that is not about a grant passes through as it is', async () => {
  for (const error of [
    new Error('ax_tree_empty: the accessibility tree was not ready'),
    new Error('cua-driver list_apps timed out after 15000ms'),
    new MittrToolError('cua-driver list_apps was cancelled', 499),
  ]) {
    const { run } = setUp({ answers: { list_apps: error } });
    await assert.rejects(run('computer.list_apps'), (thrown) => thrown === error);
  }
});

test('every driver call carries the turn\'s signal', async (t) => {
  const project = fs.realpathSync(tempDataDir(t));
  const { signal } = new AbortController();
  const { run, requests } = setUp({
    answers: {
      list_apps: { apps: [{ name: 'Notes', pid: 4, running: true }] },
      bring_to_front: { process_activated: true },
      get_desktop_state: { screenshot_png_b64: MARKER_PNG },
    },
  });
  await run('computer.list_apps', {}, { signal });
  await run('computer.bring_to_front', { app: 'Notes' }, { signal });
  await run('computer.screenshot', {}, { signal, directory: project });
  assert.equal(requests.length, 4);
  for (const request of requests) assert.equal(request.options.signal, signal, request.tool);
});

test('a driver that is not bundled makes every computer action unavailable', async () => {
  for (const options of [{ available: false }, { offered: () => false }]) {
    const { registry, run, requests } = setUp(options);
    assert.deepEqual(registry.definitions({ tool: MITTR_TOOLS.computer }).map(({ available }) => available), [false, false, false, false]);
    assert.deepEqual(registry.tools(), []);
    await assert.rejects(run('computer.list_apps'), refusedWith(503, 'List desktop apps is not available in this install'));
    assert.deepEqual(requests, []);
  }
});

test('a computer action asked for over http from another machine runs nothing', async () => {
  const { run, requests } = setUp({ answers: { list_apps: { apps: [] } } });
  await assert.rejects(run('computer.list_apps', {}, { surface: 'http', scope: { local: false } }), refusedWith(403, 'List desktop apps can only be used from this machine'));
  assert.deepEqual(requests, []);
  assert.deepEqual(await run('computer.list_apps', {}, { surface: 'http', scope: { local: true } }), { apps: [] });
});

test('open_app hands the turn\'s signal to open, and a cancelled open stays cancelled', async () => {
  const { signal } = new AbortController();
  const calls = [];
  const opened = setUp({ launchApp: async (name, options) => calls.push([name, options.signal]) });
  await opened.run('computer.open_app', { app: 'Notes' }, { signal });
  assert.deepEqual(calls, [['Notes', signal]]);

  const cancelled = new MittrToolError('open -a "Notes" was cancelled', 499);
  const { run } = setUp({ launchApp: async () => { throw cancelled; } });
  await assert.rejects(run('computer.open_app', { app: 'Notes' }), (error) => error === cancelled);
});

test('a grant named as not granted in its own clause is the one asked for', async (t) => {
  const project = fs.realpathSync(tempDataDir(t));
  const accessibility = 'MittrCraft needs the Accessibility permission for CuaDriver. Turn it on in System Settings → Privacy & Security → Accessibility.';
  const screenRecording = 'MittrCraft needs the Screen Recording permission for CuaDriver. Turn it on in System Settings → Privacy & Security → Screen Recording.';
  const listing = setUp({ answers: { list_apps: new Error('Accessibility granted, Screen Recording not granted') } });
  await assert.rejects(listing.run('computer.list_apps'), refusedWith(403, screenRecording));
  const shooting = setUp({ answers: { get_desktop_state: new Error('Screen Recording granted, Accessibility not granted') } });
  await assert.rejects(shooting.run('computer.screenshot', {}, { directory: project }), refusedWith(403, accessibility));
});

test('a screenshot answered without an image because of a missing grant names the grant', async (t) => {
  const project = fs.realpathSync(tempDataDir(t));
  const message = 'MittrCraft needs the Screen Recording permission for CuaDriver. Turn it on in System Settings → Privacy & Security → Screen Recording.';
  for (const answer of [{ error: 'Screen Recording permission not granted' }, { screen_recording: false, message: SCREEN_RECORDING_NOT_GRANTED }]) {
    const { run } = setUp({ answers: { get_desktop_state: answer } });
    await assert.rejects(run('computer.screenshot', {}, { directory: project }), refusedWith(403, message), JSON.stringify(answer));
  }
  assert.equal(fs.existsSync(path.join(project, '.openchamber')), false);

  const listing = setUp({ answers: { list_apps: { apps: [], error: 'Accessibility is NOT granted for this process.' } } });
  assert.deepEqual(await listing.run('computer.list_apps'), { apps: [] });
});

test('a screenshot that is not a PNG, JPEG or WebP image is neither saved nor returned', async (t) => {
  const project = fs.realpathSync(tempDataDir(t));
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 0]).toString('base64');
  for (const answer of [
    { screenshot_png_b64: MARKER_PNG, screenshot_mime_type: 'image/gif' },
    { screenshot_png_b64: MARKER_PNG, screenshot_mime_type: 'text/html' },
    { screenshot_png_b64: jpeg, screenshot_mime_type: 'image/png' },
    { screenshot_png_b64: Buffer.from('<svg/>').toString('base64') },
  ]) {
    const { run } = setUp({ answers: { get_desktop_state: answer } });
    await assert.rejects(run('computer.screenshot', {}, { directory: project }), refusedWith(502, 'The desktop screenshot is not a PNG, JPEG or WebP image'), JSON.stringify(answer));
  }
  assert.equal(fs.existsSync(path.join(project, '.openchamber')), false);

  const { run } = setUp({ answers: { get_desktop_state: { screenshot_png_b64: jpeg, screenshot_mime_type: 'image/jpeg' } } });
  const saved = await run('computer.screenshot', {}, { directory: project });
  assert.match(saved.path, /^\.openchamber\/screenshots\/desktop-.+\.jpg$/);
  assert.deepEqual(saved.image, { base64: jpeg, mime: 'image/jpeg' });
});

const realComputer = (t, between) => {
  const binary = stubCuaDriver(t, {
    list_apps: { apps: [{ name: 'Calculator', pid: 501, running: true }] },
    bring_to_front: { process_activated: true, exact_window_effect: { verified: true } },
  });
  const dataDir = tempDataDir(t);
  const daemon = createDriverDaemon({ binary, dataDir, env: { PATH: process.env.PATH, HOME: dataDir }, probeIntervalMs: 10 });
  t.after(() => daemon.stop());
  const control = createComputerControl({ binary, daemon });
  const wrapped = {
    available: control.available,
    token: control.token,
    request: async (tool, args, options) => {
      const answer = await control.request(tool, args, options);
      if (tool === 'list_apps') await between(control);
      return answer;
    },
  };
  return { binary, daemon, wrapped };
};

test('a stop that lands between bring_to_front\'s two requests starts no new daemon and sends nothing more', async (t) => {
  const { binary, daemon, wrapped } = realComputer(t, (control) => control.stop());
  const registry = createMittrActionRegistry({ control: { all: OPENCHAMBER_ALL_ACTIONS, execute: async () => ({}) } });
  registerComputerActions(registry, { control: wrapped, launchApp: async () => {}, writeScreenshot, offered: () => true });
  await assert.rejects(
    registry.execute('computer.bring_to_front', { app: 'Calculator' }, { surface: 'agent', tool: MITTR_TOOLS.computer }),
    refusedWith(503, DRIVER_STOPPED),
  );
  const calls = stubCuaDriverCalls(binary);
  assert.equal(calls.filter(({ command }) => command === 'serve').length, 1);
  assert.deepEqual(calls.filter(({ command }) => command === 'call').map(({ tool }) => tool), ['list_apps']);
  assert.equal(daemon.running(), false);
});

test('a tool that stops being offered between two requests of one action sends nothing more', async (t) => {
  let offered = true;
  const { binary, wrapped } = realComputer(t, async () => { offered = false; });
  const registry = createMittrActionRegistry({ control: { all: OPENCHAMBER_ALL_ACTIONS, execute: async () => ({}) } });
  registerComputerActions(registry, { control: wrapped, launchApp: async () => {}, writeScreenshot, offered: () => offered });
  await assert.rejects(
    registry.execute('computer.bring_to_front', { app: 'Calculator' }, { surface: 'agent', tool: MITTR_TOOLS.computer }),
    refusedWith(503, TURNED_OFF_MID_ACTION),
  );
  assert.deepEqual(stubCuaDriverCalls(binary).filter(({ command }) => command === 'call').map(({ tool }) => tool), ['list_apps']);
});

test('through the daemon and the gate\'s stub driver, bring_to_front brings the titled window forward past four untitled helpers', async (t) => {
  const dir = tempDataDir(t);
  const state = path.join(dir, 'state');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'mode'), 'several-windows\n');
  const stub = fileURLToPath(new URL('../../../../../scripts/mittr/stub-cua-driver.mjs', import.meta.url));
  const binary = path.join(dir, 'cua-driver');
  fs.writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@" --state "${state}"\n`, { mode: 0o755 });
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  const daemon = createDriverDaemon({ binary, dataDir, env: { PATH: process.env.PATH, HOME: dataDir }, probeIntervalMs: 10 });
  t.after(() => daemon.stop());
  const control = createComputerControl({ binary, daemon });
  const registry = createMittrActionRegistry({ control: { all: OPENCHAMBER_ALL_ACTIONS, execute: async () => ({}) } });
  registerComputerActions(registry, { control, launchApp: async () => {}, writeScreenshot, offered: () => true });
  assert.deepEqual(await registry.execute('computer.bring_to_front', { app: 'Finder' }, { surface: 'agent', tool: MITTR_TOOLS.computer }), {
    activated: true,
    windowVerified: true,
    window: { windowId: 3965, title: 'Calculator' },
  });
  const calls = fs.readFileSync(path.join(state, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(calls.filter(({ tool }) => tool).map(({ tool, args }) => [tool, args]), [
    ['list_apps', {}],
    ['bring_to_front', { pid: 4101 }],
    ['bring_to_front', { pid: 4101, window_id: 3965 }],
  ]);
});

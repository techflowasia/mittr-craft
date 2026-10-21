import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { MARKER_PNG } from '../../../../../scripts/mittr/probe-tool-plugin.mjs';
import { OPENCHAMBER_ALL_ACTIONS } from '../../../../web/server/lib/openchamber-control/actions.js';
import { writeScreenshot } from '../../../../web/server/lib/openchamber-control/screenshots.js';
import { SCREEN_RECORDING_NOT_GRANTED, tempDataDir } from '../test-helpers.js';
import { APP_NAME_PATTERN, COMPUTER_TOOL_DESCRIPTION, registerComputerActions } from './computer-actions.js';
import { MITTR_TOOLS, MittrToolError, createMittrActionRegistry } from './registry.js';
import { MAX_IMAGE_BYTES } from './screenshots.js';

const ACCESSIBILITY_NOT_GRANTED = 'Accessibility is NOT granted for this process.';
const GRANT_COMMAND_ONLY = 'run `cua-driver permissions grant` to request and verify it explicitly.';

const setUp = ({ available = true, offered = () => true, answers = {}, launchApp = async () => {}, save = writeScreenshot } = {}) => {
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
  registerComputerActions(registry, { control, launchApp, writeScreenshot: save, offered });
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
  for (const app of ['Calc; rm -rf ~', '../x', '-a', 'a'.repeat(81), ' -a', '$(id)', 'Calc\nulator']) {
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

test('bring_to_front with several windows reports the candidates and activates nothing', async () => {
  const { run } = setUp({
    answers: {
      list_apps: { apps: [{ name: 'Finder', pid: 4, running: true }] },
      bring_to_front: { code: 'ambiguous_window_target', candidates: [{ window_id: 11, title: 'Downloads' }, { window_id: 12, title: '' }] },
    },
  });
  assert.deepEqual(await run('computer.bring_to_front', { app: 'Finder' }), {
    activated: false,
    reason: 'ambiguous_window_target',
    candidates: [{ windowId: 11, title: 'Downloads' }, { windowId: 12, title: null }],
    hint: 'Several windows belong to this app; this action does not pick one for you yet.',
  });
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

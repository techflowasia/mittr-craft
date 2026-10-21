import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { tempDataDir } from '../test-helpers.js';
import {
  AGENT_BANNER_SCRIPT,
  BANNER_FILE,
  CHROME_EXECUTABLE,
  CONFIG_FILE,
  chromeSessionName,
  createChromeControl,
  resolveAgentBrowser,
  resolveChrome,
} from './chrome-control.js';
import { MittrToolError } from './registry.js';

const BINARY = '/r/agent-browser/agent-browser';

const recordingExecute = (answer = () => ({ success: true, data: {} })) => {
  const calls = [];
  const execute = async (binary, argv, options) => {
    calls.push({ binary, argv, env: options.env, cwd: options.cwd, signal: options.signal });
    return JSON.stringify(answer(argv));
  };
  return { calls, execute };
};

const controlIn = (t, { env = {}, answer, binary = BINARY } = {}) => {
  const dataDir = path.join(tempDataDir(t), 'mittrcraft-dev');
  const recorded = recordingExecute(answer);
  const control = createChromeControl({ binary, dataDir, execute: recorded.execute, env, exists: () => true });
  return { dataDir, control, ...recorded };
};

const INHERITED = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/person',
  TMPDIR: '/var/folders/xy/T/',
  LANG: 'th_TH.UTF-8',
  LC_ALL: 'th_TH.UTF-8',
  LC_CTYPE: 'UTF-8',
  CFFIXED_USER_HOME: '/tmp/p4.home',
  AGENT_BROWSER_ARGS: '--use-mock-keychain\n--password-store=basic',
  AGENT_BROWSER_AUTO_CONNECT: '1',
  AGENT_BROWSER_PROVIDER: 'browserbase',
  AGENT_BROWSER_CDP: '9222',
  AGENT_BROWSER_PROXY: 'http://proxy.example.test:8080',
  AGENT_BROWSER_HEADED: '1',
  AGENT_BROWSER_EXTENSIONS: '/tmp/ext',
  AGENT_BROWSER_CONFIG: '/tmp/other.json',
  AGENT_BROWSER_NAMESPACE: 'someone-else',
  AGENT_BROWSER_EXECUTABLE_PATH: '/tmp/other-chrome',
  HTTP_PROXY: 'http://proxy.example.test:8080',
  HTTPS_PROXY: 'http://proxy.example.test:8080',
  ALL_PROXY: 'socks5://proxy.example.test:1080',
  NO_PROXY: '*',
  NODE_OPTIONS: '--require /tmp/x.js',
  MITTRCRAFT_TOOLS_TOKEN: 'secret-token',
  XDG_RUNTIME_DIR: '/tmp/run',
};

test('an inherited AGENT_BROWSER_AUTO_CONNECT or PROVIDER never reaches the driver', async (t) => {
  const { control, calls, dataDir } = controlIn(t, { env: INHERITED });
  await control.run(['get', 'url'], { sessionName: 'mc-ses_1', profile: 'Default' });
  await control.profiles();
  await control.closeAll();

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.deepEqual(call.env, {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/person',
      TMPDIR: '/var/folders/xy/T/',
      LANG: 'th_TH.UTF-8',
      LC_ALL: 'th_TH.UTF-8',
      LC_CTYPE: 'UTF-8',
      CFFIXED_USER_HOME: '/tmp/p4.home',
      AGENT_BROWSER_ARGS: '--use-mock-keychain\n--password-store=basic',
      AGENT_BROWSER_EXECUTABLE_PATH: CHROME_EXECUTABLE,
      AGENT_BROWSER_NAMESPACE: 'mittrcraft-dev',
    });
    assert.equal(call.cwd, dataDir, 'a project agent-browser.json in the cwd is never read');
    assert.deepEqual(call.argv.slice(0, 2), ['--config', path.join(dataDir, CONFIG_FILE)], 'the user-level config is never read');
  }
  assert.equal(fs.readFileSync(path.join(dataDir, CONFIG_FILE), 'utf8'), '{}\n');
  assert.equal(fs.statSync(path.join(dataDir, CONFIG_FILE)).mode & 0o777, 0o600);
});

test('the namespace is the data folder\'s name, so prod and Dev never share a Chrome', async (t) => {
  const root = tempDataDir(t);
  for (const name of ['mittrcraft', 'mittrcraft-dev']) {
    const recorded = recordingExecute();
    const control = createChromeControl({ binary: BINARY, dataDir: path.join(root, name), execute: recorded.execute, env: {} });
    await control.closeAll();
    assert.equal(recorded.calls[0].env.AGENT_BROWSER_NAMESPACE, name);
  }
});

test('every command carries the session, the profile, json and the output cap, and a headed one the banner', async (t) => {
  const { control, calls, dataDir } = controlIn(t);
  await control.run(['open', 'https://acme.example.test/'], { sessionName: 'mc-ses_1', profile: 'Profile 2' });
  await control.run(['snapshot', '-i'], { sessionName: 'mc-ses_1', profile: 'Profile 2', headed: true });

  const config = path.join(dataDir, CONFIG_FILE);
  const banner = path.join(dataDir, BANNER_FILE);
  assert.deepEqual(calls.map(({ argv }) => argv), [
    ['--config', config, '--session', 'mc-ses_1', '--profile', 'Profile 2', '--json', '--max-output', '12000', 'open', 'https://acme.example.test/'],
    ['--config', config, '--session', 'mc-ses_1', '--profile', 'Profile 2', '--json', '--headed', '--init-script', banner, '--max-output', '12000', 'snapshot', '-i'],
  ]);
  assert.equal(fs.readFileSync(banner, 'utf8'), AGENT_BANNER_SCRIPT);
  assert.equal(fs.statSync(banner).mode & 0o777, 0o600);
  assert.match(AGENT_BANNER_SCRIPT, /MittrCraft agent กำลังควบคุมหน้าต่างนี้ · MittrCraft agent is controlling this window/);
});

test('the product passes no Chrome flag of its own, so agent-browser keeps its own launch flags', async (t) => {
  const { control, calls } = controlIn(t);
  await control.run(['open', 'https://acme.example.test/'], { sessionName: 'mc-ses_1', profile: 'Default', headed: true });
  assert.equal(calls[0].argv.some((arg) => arg === '--args' || arg.startsWith('--disable-features')), false);
  assert.equal(Object.hasOwn(calls[0].env, 'AGENT_BROWSER_ARGS'), false);
});

test('a run answers the driver\'s data without its lifecycle, and a failure says what the driver said', async (t) => {
  const answers = {
    url: { success: true, data: { url: 'https://acme.example.test/', lifecycle: { launched: true } } },
    snapshot: { success: false, error: 'Element not found' },
  };
  const { control } = controlIn(t, { answer: (argv) => answers[argv.at(-1)] ?? answers[argv.at(-2)] });
  assert.deepEqual(await control.run(['get', 'url'], { sessionName: 'mc-a', profile: 'Default' }), { url: 'https://acme.example.test/' });
  await assert.rejects(control.run(['snapshot', '-i'], { sessionName: 'mc-a', profile: 'Default' }), /^Error: Element not found$/);

  const garbled = createChromeControl({ binary: BINARY, dataDir: tempDataDir(t), execute: async () => 'not json', env: {} });
  await assert.rejects(garbled.run(['read'], { sessionName: 'mc-a', profile: 'Default' }), /agent-browser did not return JSON: not json/);
});

test('profiles lists the driver\'s Chrome profiles, and active sessions come from session list', async (t) => {
  const { control, calls } = controlIn(t, {
    answer: (argv) => (argv.includes('profiles')
      ? { success: true, data: [{ directory: 'Default', name: 'Person' }] }
      : { success: true, data: { sessions: ['mc-ses_1'] } }),
  });
  assert.deepEqual(await control.profiles(), [{ directory: 'Default', name: 'Person' }]);
  assert.deepEqual(await control.sessions(), ['mc-ses_1']);
  assert.deepEqual(calls.map(({ argv }) => argv.slice(2)), [['--json', 'profiles'], ['--json', 'session', 'list']]);
});

test('closing every Chrome never throws, even when the driver fails, and passes the abort signal', async (t) => {
  const dataDir = tempDataDir(t);
  const signals = [];
  const failing = createChromeControl({ binary: BINARY, dataDir, env: {}, execute: async (_binary, _argv, { signal }) => { signals.push(signal); throw new Error('boom'); } });
  const controller = new AbortController();
  await failing.closeAll({ signal: controller.signal });
  assert.deepEqual(signals, [controller.signal]);

  const unbundled = createChromeControl({ binary: null, dataDir, env: {}, execute: async () => assert.fail('nothing runs without a driver') });
  assert.equal(unbundled.available, false);
  await unbundled.closeAll();
  await assert.rejects(unbundled.profiles(), (error) => error instanceof MittrToolError && error.statusCode === 503 && error.message === 'The Chrome tool is not bundled in this build of MittrCraft');
});

test('the driver is the real agent-browser binary in the data folder, cancelled by the turn\'s signal', { skip: process.platform === 'win32' }, async (t) => {
  const dir = tempDataDir(t);
  const binary = path.join(dir, 'agent-browser');
  fs.writeFileSync(binary, '#!/bin/sh\neval "last=\\${$#}"\nif [ "$last" = "hang" ]; then exec /bin/sleep 30; fi\nprintf \'{"success":true,"data":{"cwd":"%s","args":"%s"}}\' "$(/bin/pwd -P)" "$*"\n', { mode: 0o755 });
  const dataDir = path.join(dir, 'mittrcraft-dev');
  const control = createChromeControl({ binary, dataDir, env: { PATH: '/usr/bin:/bin' } });
  const data = await control.run(['read'], { sessionName: 'mc-a', profile: 'Default' });
  assert.equal(data.cwd, fs.realpathSync(dataDir));
  assert.match(data.args, /--session mc-a --profile Default --json --max-output 12000 read$/);

  const started = Date.now();
  await assert.rejects(
    control.run(['hang'], { sessionName: 'mc-a', profile: 'Default', signal: AbortSignal.timeout(100) }),
    (error) => error instanceof MittrToolError && error.statusCode === 499 && error.message === 'The Chrome action was cancelled',
  );
  assert.ok(Date.now() - started < 5_000, 'the cancelled driver was killed, not waited for');
});

test('a session name keeps only safe characters', () => {
  assert.equal(chromeSessionName('ses_3c1f9a2b7ffe0123456789abcd'), 'mc-ses_3c1f9a2b7ffe0123456789abcd');
  assert.equal(chromeSessionName('ses/../--headed x'), 'mc-ses--headedx');
});

test('agent-browser comes from the set folder only, else the app resources', (t) => {
  const root = tempDataDir(t);
  const resourcesDir = path.join(root, 'Resources');
  const envDir = path.join(root, 'env');
  fs.mkdirSync(path.join(resourcesDir, 'agent-browser'), { recursive: true });
  fs.writeFileSync(path.join(resourcesDir, 'agent-browser', 'agent-browser'), '');
  fs.mkdirSync(envDir);
  assert.equal(resolveAgentBrowser({ resourcesDir, env: {}, exists: fs.existsSync }), path.join(resourcesDir, 'agent-browser', 'agent-browser'));
  assert.equal(resolveAgentBrowser({ resourcesDir, env: { MITTRCRAFT_BUNDLED_AGENT_BROWSER_DIR: envDir }, exists: fs.existsSync }), null);
  fs.writeFileSync(path.join(envDir, 'agent-browser'), '');
  assert.equal(resolveAgentBrowser({ resourcesDir, env: { MITTRCRAFT_BUNDLED_AGENT_BROWSER_DIR: envDir }, exists: fs.existsSync }), path.join(envDir, 'agent-browser'));
});

test('Chrome is found in /Applications, else in the person\'s own Applications folder', () => {
  const inHome = '/Users/person/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.equal(resolveChrome({ home: '/Users/person', exists: () => true }), CHROME_EXECUTABLE);
  assert.equal(resolveChrome({ home: '/Users/person', exists: (file) => file === inHome }), inHome);
  assert.equal(resolveChrome({ home: '/Users/person', exists: () => false }), null);
  assert.equal(CHROME_EXECUTABLE, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
});

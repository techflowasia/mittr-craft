import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createMittrSettings, isHost } from './mittr-settings.js';
import { tempDataDir } from './test-helpers.js';

const recordingLogger = () => {
  const warnings = [];
  return { warnings, log: () => {}, warn: (...args) => warnings.push(args.join(' ')) };
};

const settingsFile = (dataDir) => path.join(dataDir, 'mittr-settings.json');

const DEFAULT_TOOLS = { computer: true, chrome: true, chromeProfile: null, chromeHeaded: false, chromeApprovedHosts: [] };
const DEFAULT_VOICE = { stepCap: 8, replyMaxChars: 8000 };
const stored = (showOtherProviders, tools = DEFAULT_TOOLS, voice = DEFAULT_VOICE) => ({ showOtherProviders, tools, voice });

test('missing settings read as switch OFF, with no warning', async (t) => {
  const dataDir = tempDataDir(t);
  const logger = recordingLogger();
  assert.deepEqual(await createMittrSettings({ dataDir, logger }).read(), stored(false));
  assert.deepEqual(logger.warnings, []);
});

test('the stored switch is honoured', async (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(settingsFile(dataDir), JSON.stringify({ showOtherProviders: true }));
  assert.deepEqual(await createMittrSettings({ dataDir, logger: recordingLogger() }).read(), stored(true));
});

test('corrupt settings read as switch OFF, with one warning naming the file', async (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(settingsFile(dataDir), '{');
  const logger = recordingLogger();
  const settings = createMittrSettings({ dataDir, logger });
  assert.deepEqual(await settings.read(), stored(false));
  assert.deepEqual(await settings.read(), stored(false));
  assert.equal(logger.warnings.length, 1);
  assert.ok(logger.warnings[0].includes(settingsFile(dataDir)), logger.warnings[0]);
});

test('a value that is not exactly true reads as switch OFF', async (t) => {
  const dataDir = tempDataDir(t);
  for (const value of [{ showOtherProviders: 'true' }, { showOtherProviders: 1 }, [], null, 'yes']) {
    fs.writeFileSync(settingsFile(dataDir), JSON.stringify(value));
    assert.deepEqual(await createMittrSettings({ dataDir, logger: recordingLogger() }).read(), stored(false), JSON.stringify(stored));
  }
});

test('settings that cannot be read fail closed', async (t) => {
  const dataDir = tempDataDir(t);
  fs.mkdirSync(settingsFile(dataDir));
  const logger = recordingLogger();
  assert.deepEqual(await createMittrSettings({ dataDir, logger }).read(), stored(false));
  assert.equal(logger.warnings.length, 1);
});

const modeOf = (file) => fs.statSync(file).mode & 0o777;

test('update stores the switch in a private file that a new store reads back', async (t) => {
  const dataDir = tempDataDir(t);
  const settings = createMittrSettings({ dataDir, logger: recordingLogger() });
  assert.deepEqual(await settings.update({ showOtherProviders: true }), stored(true));

  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile(dataDir), 'utf8')), { showOtherProviders: true });
  assert.equal(modeOf(settingsFile(dataDir)), 0o600);
  assert.deepEqual(await createMittrSettings({ dataDir, logger: recordingLogger() }).read(), stored(true));
  assert.deepEqual(fs.readdirSync(dataDir), ['mittr-settings.json'], 'no temp file is left behind');

  assert.deepEqual(await settings.update({ showOtherProviders: false }), stored(false));
  assert.deepEqual(await settings.read(), stored(false));
  assert.equal(modeOf(settingsFile(dataDir)), 0o600);
});

test('an existing file with looser permissions becomes private on the next update', async (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(settingsFile(dataDir), JSON.stringify({ showOtherProviders: true }), { mode: 0o644 });
  await createMittrSettings({ dataDir, logger: recordingLogger() }).update({ showOtherProviders: false });
  assert.equal(modeOf(settingsFile(dataDir)), 0o600);
});

test('updates run one at a time, so the last one asked for is the one stored', async (t) => {
  const dataDir = tempDataDir(t);
  const settings = createMittrSettings({ dataDir, logger: recordingLogger() });
  const results = await Promise.all([true, false, true, false].map((value) => settings.update({ showOtherProviders: value })));
  assert.deepEqual(results.map((result) => result.showOtherProviders), [true, false, true, false]);
  assert.deepEqual(await settings.read(), stored(false));
});

test('an update over a corrupt file replaces it', async (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(settingsFile(dataDir), '{');
  const settings = createMittrSettings({ dataDir, logger: recordingLogger() });
  await settings.update({ showOtherProviders: true });
  assert.deepEqual(await settings.read(), stored(true));
});

test('update takes only an explicit true or false, and a refused one writes nothing', async (t) => {
  const dataDir = tempDataDir(t);
  const settings = createMittrSettings({ dataDir, logger: recordingLogger() });
  for (const patch of [{}, { showOtherProviders: 'true' }, { showOtherProviders: 1 }, null]) {
    await assert.rejects(settings.update(patch), /showOtherProviders/, JSON.stringify(patch));
  }
  assert.equal(fs.existsSync(settingsFile(dataDir)), false);
  assert.deepEqual(await settings.update({ showOtherProviders: true }), stored(true));
});

test('tools read as 1.22 defaults, and each invalid field reads as its default', async (t) => {
  const dataDir = tempDataDir(t);
  const settings = createMittrSettings({ dataDir, logger: recordingLogger() });
  fs.writeFileSync(settingsFile(dataDir), JSON.stringify({ tools: { computer: false, chrome: 'no', chromeProfile: 'Profile 1', chromeHeaded: 1, chromeApprovedHosts: 'a.test' } }));
  assert.deepEqual((await settings.read()).tools, { ...DEFAULT_TOOLS, computer: false, chromeProfile: 'Profile 1' });
  for (const chromeProfile of ['  ', '--headed', '/Users/person/Library/Application Support/Google/Chrome', 'Profile 1/../..', '.', '..', '~', 'Profile 1\\x', 'Profile\u00001']) {
    fs.writeFileSync(settingsFile(dataDir), JSON.stringify({ tools: { chromeProfile, chromeHeaded: true } }));
    assert.deepEqual((await settings.read()).tools, { ...DEFAULT_TOOLS, chromeHeaded: true }, chromeProfile);
  }
  for (const tools of [null, [], 'x', 3]) {
    fs.writeFileSync(settingsFile(dataDir), JSON.stringify({ tools }));
    assert.deepEqual((await settings.read()).tools, DEFAULT_TOOLS, JSON.stringify(tools));
  }
});

test('a bad host in the stored list is dropped on read', async (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(settingsFile(dataDir), JSON.stringify({ tools: { chromeApprovedHosts: ['Docs.Example.Test', 'docs.example.test', 'bad host', 'a.test:8080', 'evil.test/path', 7, null, 'ok-1.test', '[2001:DB8::1]', '2001:db8::1', '[::1]:8080', '[fe80::1%en0]', '[]'] } }));
  assert.deepEqual((await createMittrSettings({ dataDir, logger: recordingLogger() }).read()).tools.chromeApprovedHosts, ['docs.example.test', 'ok-1.test', '[2001:db8::1]']);
});

test('a tools update merges onto what is stored and returns it', async (t) => {
  const dataDir = tempDataDir(t);
  const settings = createMittrSettings({ dataDir, logger: recordingLogger() });
  assert.deepEqual(await settings.update({ tools: { chrome: false } }), stored(false, { ...DEFAULT_TOOLS, chrome: false }));
  assert.deepEqual(await settings.update({ tools: { chromeProfile: 'Default', chromeApprovedHosts: ['A.test', 'a.test'] } }), stored(false, { ...DEFAULT_TOOLS, chrome: false, chromeProfile: 'Default', chromeApprovedHosts: ['a.test'] }));
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile(dataDir), 'utf8')), { tools: { ...DEFAULT_TOOLS, chrome: false, chromeProfile: 'Default', chromeApprovedHosts: ['a.test'] } });
  assert.equal(fs.statSync(settingsFile(dataDir)).mode & 0o777, 0o600);
});

test('a provider-switch write keeps tools', async (t) => {
  const dataDir = tempDataDir(t);
  const settings = createMittrSettings({ dataDir, logger: recordingLogger() });
  await settings.update({ tools: { computer: false } });
  await settings.update({ showOtherProviders: true });
  assert.deepEqual(await settings.read(), stored(true, { ...DEFAULT_TOOLS, computer: false }));
});

test('a tools write keeps the switch', async (t) => {
  const dataDir = tempDataDir(t);
  const settings = createMittrSettings({ dataDir, logger: recordingLogger() });
  await settings.update({ showOtherProviders: true });
  await settings.update({ tools: { chromeHeaded: true } });
  assert.deepEqual(await settings.read(), stored(true, { ...DEFAULT_TOOLS, chromeHeaded: true }));
});

test('an invalid tools patch is refused and writes nothing', async (t) => {
  const dataDir = tempDataDir(t);
  const settings = createMittrSettings({ dataDir, logger: recordingLogger() });
  for (const [tools, key] of [
    [{ chrome: 'off' }, 'chrome'],
    [{ computer: null }, 'computer'],
    [{ chromeProfile: '' }, 'chromeProfile'],
    [{ chromeProfile: '--headed' }, 'chromeProfile'],
    [{ chromeProfile: '~/Library/Application Support/Google/Chrome' }, 'chromeProfile'],
    [{ chromeProfile: '.' }, 'chromeProfile'],
    [{ chromeProfile: '..' }, 'chromeProfile'],
    [{ chromeProfile: '~' }, 'chromeProfile'],
    [{ chromeProfile: '~person' }, 'chromeProfile'],
    [{ chromeProfile: 'Profile 1\\..' }, 'chromeProfile'],
    [{ chromeProfile: 'Profile\u00001' }, 'chromeProfile'],
    [{ chromeHeaded: 1 }, 'chromeHeaded'],
    [{ chromeApprovedHosts: ['a b'] }, 'chromeApprovedHosts'],
    [{ chromeApprovedHosts: 'a.test' }, 'chromeApprovedHosts'],
    [{ voice: true }, 'voice'],
  ]) {
    await assert.rejects(settings.update({ tools }), new RegExp(`^TypeError: Unknown or invalid tool setting: ${key}$`), JSON.stringify(tools));
  }
  await assert.rejects(settings.update({ tools: null }), /tools/);
  assert.equal(fs.existsSync(settingsFile(dataDir)), false);
});

const writeParked = (dataDir, settings) => {
  const file = path.join(dataDir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
};

test('1.22 tool settings parked under mittr are carried once', async (t) => {
  const dataDir = tempDataDir(t);
  const parked = writeParked(dataDir, {
    desktopLocalPort: 57123,
    mittr: {
      agentComputerToolEnabled: false,
      agentChromeToolEnabled: true,
      agentChromeProfile: 'Profile 2',
      agentChromeHeaded: true,
      agentChromeApprovedHosts: ['Jira.Example.Test', 'not a host'],
      voiceStepCap: 3,
    },
  });
  const before = fs.readFileSync(parked, 'utf8');
  const settings = createMittrSettings({ dataDir, logger: recordingLogger() });
  const carried = { computer: false, chrome: true, chromeProfile: 'Profile 2', chromeHeaded: true, chromeApprovedHosts: ['jira.example.test'] };
  assert.deepEqual(await settings.carryParkedToolSettings(), carried);
  assert.deepEqual(await settings.read(), stored(false, carried));
  assert.equal(await settings.carryParkedToolSettings(), null, 'a second carry finds tools stored and does nothing');
  assert.equal(fs.readFileSync(parked, 'utf8'), before, 'settings.json is never written');
});

test('a later change is not overwritten by the carry', async (t) => {
  const dataDir = tempDataDir(t);
  writeParked(dataDir, { mittr: { agentChromeToolEnabled: true, agentChromeHeaded: false } });
  const first = createMittrSettings({ dataDir, logger: recordingLogger() });
  await first.carryParkedToolSettings();
  await first.update({ tools: { chrome: false } });
  const nextStart = createMittrSettings({ dataDir, logger: recordingLogger() });
  assert.equal(await nextStart.carryParkedToolSettings(), null);
  assert.equal((await nextStart.read()).tools.chrome, false);
});

test('nothing parked carries nothing and writes no file', async (t) => {
  const dataDir = tempDataDir(t);
  const settings = createMittrSettings({ dataDir, logger: recordingLogger() });
  assert.equal(await settings.carryParkedToolSettings(), null);
  writeParked(dataDir, { mittr: { voiceStepCap: 3 } });
  assert.equal(await settings.carryParkedToolSettings(), null);
  assert.equal(fs.existsSync(settingsFile(dataDir)), false);
});

test('a carry keeps the stored provider switch', async (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(settingsFile(dataDir), JSON.stringify({ showOtherProviders: true }));
  writeParked(dataDir, { mittr: { agentComputerToolEnabled: false } });
  const settings = createMittrSettings({ dataDir, logger: recordingLogger() });
  await settings.carryParkedToolSettings();
  assert.deepEqual(await settings.read(), stored(true, { ...DEFAULT_TOOLS, computer: false }));
});

test('a bracketed site is only an IPv6 address in the form a page address gives', () => {
  for (const host of ['[:]', '[:::]', '[1]', '[abc]', '[dead:beef]', '[1:2:3:4:5:6:7:8:9:a:b]', '[::ffff:1.2.3.4]', '[fe80::1%en0]', '[2001:0db8::1]', '[]']) {
    assert.equal(isHost(host), false, host);
  }
  for (const url of ['http://[::1]:8080/', 'https://[2001:DB8:0::1]/', 'http://[::ffff:192.0.2.10]/']) {
    const host = new URL(url).hostname.toLowerCase();
    assert.equal(isHost(host), true, host);
  }
});

test('a 1.22 Mittr dictation choice is carried once', async (t) => {
  const dataDir = tempDataDir(t);
  writeParked(dataDir, { mittr: { sttProvider: 'mittr' } });
  const settings = createMittrSettings({ dataDir, logger: recordingLogger() });
  assert.equal(await settings.dictationCarryPending(), true);
  await settings.update({ showOtherProviders: true });
  assert.equal(await settings.dictationCarryPending(), true, 'another setting keeps the carry');
  await settings.markDictationCarried();
  assert.equal(await settings.dictationCarryPending(), false);
  await settings.update({ tools: { chrome: false } });
  const nextStart = createMittrSettings({ dataDir, logger: recordingLogger() });
  assert.equal(await nextStart.dictationCarryPending(), false);
  assert.equal((await nextStart.read()).showOtherProviders, true);

  const none = tempDataDir(t);
  writeParked(none, { mittr: { sttProvider: 'local' } });
  assert.equal(await createMittrSettings({ dataDir: none, logger: recordingLogger() }).dictationCarryPending(), false);
  assert.equal(await createMittrSettings({ dataDir: tempDataDir(t), logger: recordingLogger() }).dictationCarryPending(), false);
});

test('the voice limits read as 1.22 did: a step cap out of range falls back, a reply length is clamped', async (t) => {
  const dataDir = tempDataDir(t);
  const settings = createMittrSettings({ dataDir, logger: recordingLogger() });
  assert.deepEqual((await settings.read()).voice, { stepCap: 8, replyMaxChars: 8000 });
  for (const [voice, expected] of [
    [{ stepCap: 0, replyMaxChars: 500 }, { stepCap: 8, replyMaxChars: 1000 }],
    [{ stepCap: 21, replyMaxChars: 99_999 }, { stepCap: 8, replyMaxChars: 30000 }],
    [{ stepCap: 2.5, replyMaxChars: 1234.6 }, { stepCap: 8, replyMaxChars: 1235 }],
    [{ stepCap: '3', replyMaxChars: 'many' }, { stepCap: 8, replyMaxChars: 8000 }],
    [{ stepCap: 3, replyMaxChars: 2000 }, { stepCap: 3, replyMaxChars: 2000 }],
  ]) {
    fs.writeFileSync(settingsFile(dataDir), JSON.stringify({ voice }));
    assert.deepEqual((await settings.read()).voice, expected, JSON.stringify(voice));
  }
});

test('update takes voice limits in range, keeps the other settings, and refuses the rest', async (t) => {
  const dataDir = tempDataDir(t);
  const settings = createMittrSettings({ dataDir, logger: recordingLogger() });
  await settings.update({ showOtherProviders: true, tools: { chrome: false } });
  assert.deepEqual((await settings.update({ voice: { stepCap: 3 } })).voice, { stepCap: 3, replyMaxChars: 8000 });
  assert.deepEqual((await settings.update({ voice: { replyMaxChars: 1000 } })).voice, { stepCap: 3, replyMaxChars: 1000 });
  const after = await settings.read();
  assert.equal(after.showOtherProviders, true);
  assert.equal(after.tools.chrome, false);
  for (const voice of [{ stepCap: 0 }, { stepCap: 21 }, { replyMaxChars: 999 }, { replyMaxChars: 30001 }, { stepCap: 2.5 }, { other: 1 }, []]) {
    await assert.rejects(settings.update({ voice }), TypeError, JSON.stringify(voice));
  }
  assert.deepEqual((await settings.read()).voice, { stepCap: 3, replyMaxChars: 1000 });
});

test('1.22 voice limits parked under mittr are carried once', async (t) => {
  const dataDir = tempDataDir(t);
  writeParked(dataDir, { mittr: { voiceStepCap: 4, voiceReplyMaxChars: 12000, agentChromeToolEnabled: false } });
  const settings = createMittrSettings({ dataDir, logger: recordingLogger() });
  assert.deepEqual(await settings.carryParkedVoiceSettings(), { stepCap: 4, replyMaxChars: 12000 });
  assert.deepEqual((await settings.read()).voice, { stepCap: 4, replyMaxChars: 12000 });
  await settings.update({ voice: { stepCap: 6 } });
  assert.equal(await createMittrSettings({ dataDir, logger: recordingLogger() }).carryParkedVoiceSettings(), null);
  assert.equal((await settings.read()).voice.stepCap, 6);
  assert.equal(await createMittrSettings({ dataDir: tempDataDir(t), logger: recordingLogger() }).carryParkedVoiceSettings(), null);
});

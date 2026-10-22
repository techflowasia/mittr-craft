import assert from 'node:assert/strict';
import test from 'node:test';

import { OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS, OPENCHAMBER_ALL_ACTIONS, OPENCHAMBER_WEB_ACTION_DEFINITIONS } from '../../../../web/server/lib/openchamber-control/actions.js';
import { MITTR_TOOLS, createMittrActionRegistry } from '../tools/registry.js';
import { END_TOOL_DESCRIPTION } from './descriptions.js';
import { END_TOOL, READ_ACTIONS, REFUSED_AFTER_READ, VOICE_END_TITLE, VOICE_SESSION_ID, VOICE_STEP_CAP, VOICE_STRIPPED_INPUTS, VOICE_TOOLS, VOICE_UPSTREAM_ACTIONS, buildVoiceTools, guardCall, voiceActionTitles } from './tools.js';

const UPSTREAM = { control: OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS, web: OPENCHAMBER_WEB_ACTION_DEFINITIONS };
const ALL_ON = { control: true, web: true, chrome: true, computer: true };

const setUpRegistry = ({ chromeAvailable = true, doTask = true } = {}) => {
  const registry = createMittrActionRegistry({ control: { all: OPENCHAMBER_ALL_ACTIONS, definitions: () => UPSTREAM, execute: async () => ({}) } });
  const run = async () => ({});
  registry.defineTool({ name: MITTR_TOOLS.chrome, description: 'chrome', parameters: { url: { type: 'string', description: 'u' } } });
  registry.defineTool({ name: MITTR_TOOLS.computer, description: 'Desktop tool text.', parameters: { app: { type: 'string', description: 'App name' } } });
  registry.defineTool({ name: MITTR_TOOLS.work, description: 'work', parameters: { key: { type: 'string', description: 'Jira key' }, ref: { type: 'string', description: 'Plane ref' } } });
  registry.defineTool({ name: VOICE_TOOLS.voice, description: 'voice', parameters: {} });
  const chromeOn = () => chromeAvailable;
  for (const [action, effect] of [['chrome.open', 'read'], ['chrome.read', 'read']]) registry.register({ action, tool: MITTR_TOOLS.chrome, title: action, description: `${action} text`, effect, available: chromeOn, execute: run });
  registry.register({ action: 'chrome.do', tool: MITTR_TOOLS.chrome, title: 'Do', description: 'do', effect: 'change', available: () => chromeAvailable && doTask, execute: run });
  registry.register({ action: 'computer.screenshot', tool: MITTR_TOOLS.computer, title: 'Screenshot the desktop', description: 'shot', effect: 'read', execute: run });
  registry.register({ action: 'jira.get_issue', tool: MITTR_TOOLS.work, title: 'Read a Jira issue', description: 'jira', effect: 'read', execute: run });
  registry.register({ action: 'plane.get_issue', tool: MITTR_TOOLS.work, title: 'Read a Plane work item', description: 'plane', effect: 'read', execute: run });
  registry.register({ action: 'session.stop', tool: VOICE_TOOLS.voice, title: 'Stop a session', description: 'stop', effect: 'change', voiceOnly: true, execute: run });
  registry.register({ action: 'session.read_reply', tool: VOICE_TOOLS.voice, title: "Read a session's latest answer", description: 'reply', effect: 'read', voiceOnly: true, execute: run });
  registry.register({ action: 'chrome.allow_site', tool: VOICE_TOOLS.voice, title: 'Allow Chrome for this conversation', description: 'allow', effect: 'change', voiceOnly: true, available: chromeOn, execute: run });
  return registry;
};

const actionsOf = (tools) => Object.fromEntries(tools.map((tool) => [tool.name, tool.parameters.properties.action?.enum ?? []]));

test('the constants are 1.22\'s', () => {
  assert.equal(VOICE_SESSION_ID, 'voice');
  assert.deepEqual(VOICE_STEP_CAP, { fallback: 8, min: 1, max: 20 });
  assert.deepEqual(VOICE_STRIPPED_INPUTS, ['wait', 'timeout', 'lastAssistant', 'returnResult']);
  assert.equal(READ_ACTIONS.size, 12);
  assert.equal(REFUSED_AFTER_READ.size, 9);
  assert.equal(VOICE_END_TITLE, 'End the conversation');
});

test('the tools offer 1.22\'s actions and no session.link, file.open, memory or notify', () => {
  const tools = buildVoiceTools({ upstream: UPSTREAM, registry: setUpRegistry(), switches: ALL_ON });
  const offered = actionsOf(tools);
  assert.deepEqual(Object.keys(offered), ['mittrcraft', 'mittrcraft_web', 'mittrcraft_voice', 'mittrcraft_end']);
  assert.deepEqual(offered.mittrcraft, [
    'projects.list', 'models.list', 'session.list', 'session.create', 'session.send', 'session.fork', 'session.status', 'session.messages',
    'schedule.list', 'schedule.create', 'schedule.run', 'schedule.delete', 'schedule.toggle', 'jira.get_issue', 'plane.get_issue',
  ]);
  assert.deepEqual(offered.mittrcraft_web, [
    'browser.open', 'browser.snapshot', 'browser.click', 'browser.type', 'browser.scroll', 'browser.back', 'browser.forward', 'browser.inspect', 'browser.capture', 'browser.resize',
    'chrome.open', 'chrome.read', 'chrome.do', 'computer.screenshot',
  ]);
  const everything = Object.values(offered).flat();
  for (const banned of ['session.link', 'file.open', 'notify.send', 'schedule.status']) assert.equal(everything.includes(banned), false, banned);
  assert.equal(everything.some((action) => action.startsWith('memory.')), false);
  assert.deepEqual(VOICE_UPSTREAM_ACTIONS.filter((action) => !everything.includes(action)), []);
});

test('a switched-off tool\'s actions leave every voice tool, and chrome.allow_site only where Chrome can run', () => {
  const registry = setUpRegistry();
  const noControl = actionsOf(buildVoiceTools({ upstream: UPSTREAM, registry, switches: { ...ALL_ON, control: false } }));
  assert.equal(Object.hasOwn(noControl, 'mittrcraft'), false);
  assert.deepEqual(noControl.mittrcraft_voice, ['chrome.allow_site']);

  const noWeb = actionsOf(buildVoiceTools({ upstream: UPSTREAM, registry, switches: { ...ALL_ON, web: false, computer: false } }));
  assert.deepEqual(noWeb.mittrcraft_web, ['chrome.open', 'chrome.read', 'chrome.do']);

  const noChrome = actionsOf(buildVoiceTools({ upstream: UPSTREAM, registry, switches: { ...ALL_ON, chrome: false } }));
  assert.equal(noChrome.mittrcraft_web.some((action) => action.startsWith('chrome.')), false);
  assert.deepEqual(noChrome.mittrcraft_voice, ['session.stop', 'session.read_reply']);

  const chromeMissing = actionsOf(buildVoiceTools({ upstream: UPSTREAM, registry: setUpRegistry({ chromeAvailable: false }), switches: ALL_ON }));
  assert.equal(Object.values(chromeMissing).flat().some((action) => action.startsWith('chrome.')), false);

  assert.deepEqual(buildVoiceTools({ upstream: UPSTREAM, registry, switches: {} }), []);
});

test('the voice-only actions appear in mittrcraft_voice and nowhere else', () => {
  const offered = actionsOf(buildVoiceTools({ upstream: UPSTREAM, registry: setUpRegistry(), switches: ALL_ON }));
  assert.deepEqual(offered.mittrcraft_voice, ['session.stop', 'session.read_reply', 'chrome.allow_site']);
  for (const [name, actions] of Object.entries(offered)) {
    if (name === 'mittrcraft_voice') continue;
    for (const action of ['session.stop', 'session.read_reply', 'chrome.allow_site']) assert.equal(actions.includes(action), false, `${name} ${action}`);
  }
});

test('wait, timeout, lastAssistant and returnResult are never offered', () => {
  for (const tool of buildVoiceTools({ upstream: UPSTREAM, registry: setUpRegistry(), switches: ALL_ON })) {
    for (const name of VOICE_STRIPPED_INPUTS) assert.equal(Object.hasOwn(tool.parameters.properties, name), false, `${tool.name} ${name}`);
  }
});

test('every tool fits the platform\'s limits, with the action as enum plus oneOf', () => {
  const tools = buildVoiceTools({ upstream: UPSTREAM, registry: setUpRegistry(), switches: ALL_ON });
  assert.ok(tools.length <= 4);
  for (const tool of tools) {
    assert.ok(tool.description.length <= 4000, tool.name);
    assert.ok(JSON.stringify(tool.parameters).length <= 30_000, tool.name);
    if (tool.name === 'mittrcraft_end') continue;
    const { action } = tool.parameters.properties;
    assert.deepEqual(action.oneOf.map((entry) => entry.const), action.enum);
    assert.equal(tool.parameters.additionalProperties, false);
  }
  const web = tools.find((tool) => tool.name === 'mittrcraft_web');
  assert.match(web.description, /chrome\.do/);
  assert.match(web.description, /Desktop tool text\./);
  assert.ok(web.parameters.properties.goal, 'chrome.do inputs are offered with chrome.do');
  assert.equal(web.parameters.properties.url.description, "http(s) URL for browser.open; http(s) URL for chrome.open");
  const noTask = buildVoiceTools({ upstream: UPSTREAM, registry: setUpRegistry({ doTask: false }), switches: ALL_ON }).find((tool) => tool.name === 'mittrcraft_web');
  assert.doesNotMatch(noTask.description, /chrome\.do/);
  assert.equal(Object.hasOwn(noTask.parameters.properties, 'goal'), false);
});

test('the end tool is offered whenever anything else is', () => {
  const registry = setUpRegistry();
  for (const switches of [ALL_ON, { control: true }, { web: true }, { chrome: true }]) {
    const tools = buildVoiceTools({ upstream: UPSTREAM, registry, switches });
    assert.deepEqual(tools.at(-1), END_TOOL, JSON.stringify(switches));
  }
  assert.equal(END_TOOL.name, 'mittrcraft_end');
  assert.equal(END_TOOL.description, END_TOOL_DESCRIPTION);
  assert.match(END_TOOL_DESCRIPTION, /จบการสนทนา/);
});

test('every offered action has a title', () => {
  const titles = voiceActionTitles({ upstream: UPSTREAM, registry: setUpRegistry() });
  for (const action of Object.values(actionsOf(buildVoiceTools({ upstream: UPSTREAM, registry: setUpRegistry(), switches: ALL_ON }))).flat()) {
    assert.ok(titles[action], action);
  }
  assert.equal(titles['session.list'], 'List sessions');
});

test('a send after chrome.read in the same step is refused and not run', () => {
  assert.deepEqual(guardCall('session.send', { readSeen: true }), {
    refuse: { reasonCode: 'refused_after_read', error: 'session.send is not run after something was read in the same turn; ask the person again and wait for their answer' },
  });
  assert.deepEqual(guardCall('session.send', { readSeen: false }), { ok: true });
});

test('chrome.allow_site after any read in the turn is refused', () => {
  assert.equal(guardCall('chrome.allow_site', { readSeen: true, pendingHost: 'a.test' }).refuse.reasonCode, 'refused_after_read');
  assert.deepEqual(guardCall('chrome.allow_site', { pendingHost: 'a.test' }), { ok: true });
  assert.equal(guardCall('chrome.allow_site', {}).refuse.reasonCode, 'not_requested');
  assert.deepEqual(guardCall('chrome.allow_site', { chromeAllowed: true, readSeen: true }), {
    ok: true, answer: { allowed: true, scope: 'conversation', sites: 'all', note: 'Chrome was already allowed in this conversation; do not ask again' },
  });
});

test('a lookup (session.list, session.status) is not a read', () => {
  assert.equal(READ_ACTIONS.has('session.list'), false);
  assert.equal(READ_ACTIONS.has('session.status'), false);
  assert.deepEqual(guardCall('session.list', { readSeen: true }), { ok: true });
});

test('session.stop needs the assistant to have spoken first', () => {
  assert.equal(guardCall('session.stop', {}).refuse.reasonCode, 'confirm_first');
  assert.deepEqual(guardCall('session.stop', { assistantSpokeBefore: true }), { ok: true });
});

import { VOICE_STEP_TIMEOUT_MS } from '../platform.js';
import { chromeToolDescription, chromeToolParameters } from '../tools/chrome-service.js';
import { MITTR_TOOLS } from '../tools/registry.js';
import { CONTROL_ACTION_DEFINITIONS, CONTROL_TOOL_DESCRIPTION, END_TOOL_DESCRIPTION, VOICE_ACTION_DEFINITIONS, VOICE_TOOL_DESCRIPTION, WEB_ACTION_DEFINITIONS, WEB_TOOL_DESCRIPTION } from './descriptions.js';
import { CONTROL_PARAMETER_PROPERTIES, HOST_PARAMETER, WEB_PARAMETER_PROPERTIES } from './parameters.js';

export const READ_ACTIONS = Object.freeze(new Set([
  'session.read_reply', 'session.messages',
  'chrome.read', 'chrome.snapshot', 'chrome.screenshot', 'chrome.do',
  'browser.snapshot', 'browser.inspect', 'browser.capture',
  'computer.screenshot', 'jira.get_issue', 'plane.get_issue',
]));
export const REFUSED_AFTER_READ = Object.freeze(new Set([
  'session.stop', 'session.send', 'session.create', 'session.fork',
  'schedule.create', 'schedule.run', 'schedule.delete', 'schedule.toggle',
  'chrome.allow_site',
]));
export const STEP_CALLS_MAX = 20;
export const VOICE_TOOL_RESULT_MAX_CHARS = 20_000;
export const MESSAGES_MAX_COUNT = 60;
export const MESSAGES_MAX_CHARS = 200_000;
export const STEP_TIMEOUT_MS = VOICE_STEP_TIMEOUT_MS;
export { VOICE_REPLY_MAX_CHARS, VOICE_STEP_CAP } from '../mittr-settings.js';
export const VOICE_STRIPPED_INPUTS = Object.freeze(['wait', 'timeout', 'lastAssistant', 'returnResult']);

export const VOICE_CONTROL_ACTIONS = Object.freeze(CONTROL_ACTION_DEFINITIONS.map(({ action }) => action));
export const VOICE_WEB_ACTIONS = Object.freeze(WEB_ACTION_DEFINITIONS.map(({ action }) => action));
export const VOICE_UPSTREAM_ACTIONS = Object.freeze([...VOICE_CONTROL_ACTIONS, ...VOICE_WEB_ACTIONS]);
export const VOICE_ONLY_ACTIONS = Object.freeze(VOICE_ACTION_DEFINITIONS.map(({ action }) => action));

export const VOICE_SESSION_ID = 'voice';
export const VOICE_TOOLS = Object.freeze({ control: 'mittrcraft', web: 'mittrcraft_web', voice: 'mittrcraft_voice', end: 'mittrcraft_end' });
export const VOICE_END_TITLE = 'End the conversation';

export const END_TOOL = Object.freeze({
  name: VOICE_TOOLS.end,
  description: END_TOOL_DESCRIPTION,
  parameters: Object.freeze({ type: 'object', properties: {}, additionalProperties: false }),
});

const ALREADY_ALLOWED = Object.freeze({ allowed: true, scope: 'conversation', sites: 'all', note: 'Chrome was already allowed in this conversation; do not ask again' });

const without = (properties, names) => Object.fromEntries(Object.entries(properties).filter(([name]) => !names.includes(name)));

export const mergeProperties = (...groups) => {
  const merged = {};
  for (const group of groups) {
    for (const [name, schema] of Object.entries(group)) {
      const existing = merged[name];
      merged[name] = existing && existing.description !== schema.description
        ? { ...existing, description: `${existing.description}; ${schema.description}` }
        : { ...schema };
    }
  }
  return without(merged, VOICE_STRIPPED_INPUTS);
};

const toolSchema = ({ name, description, definitions, properties }) => ({
  name,
  description,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: definitions.map(({ action }) => action),
        oneOf: definitions.map((entry) => ({ const: entry.action, description: entry.description })),
        description: 'MittrCraft action to perform',
      },
      ...properties,
    },
    required: ['action'],
    additionalProperties: false,
  },
});

const offeredUpstream = (upstream, vendored) => {
  const present = new Set([...(upstream?.control ?? []), ...(upstream?.web ?? [])].map(({ action }) => action));
  return vendored.filter(({ action }) => present.has(action));
};

const registryToolOf = (registry, name) => registry.tools().find((tool) => tool.name === name) ?? null;

const voiceOnlyDefinitions = (registry) => registry.definitions({ includeVoiceOnly: true }).filter((entry) => entry.voiceOnly && entry.available);

export const buildVoiceTools = ({ upstream, registry, switches }) => {
  const on = { control: switches?.control === true, web: switches?.web === true, chrome: switches?.chrome === true, computer: switches?.computer === true };
  const work = on.control ? registryToolOf(registry, MITTR_TOOLS.work) : null;
  const chrome = on.chrome ? registryToolOf(registry, MITTR_TOOLS.chrome) : null;
  const computer = on.computer ? registryToolOf(registry, MITTR_TOOLS.computer) : null;
  const doTask = Boolean(chrome?.definitions.some(({ action }) => action === 'chrome.do'));
  const voiceOnly = voiceOnlyDefinitions(registry).filter(({ action }) => (action === 'chrome.allow_site' ? Boolean(chrome) : on.control));

  const tools = [
    toolSchema({
      name: VOICE_TOOLS.control,
      description: CONTROL_TOOL_DESCRIPTION,
      definitions: [...(on.control ? offeredUpstream(upstream, CONTROL_ACTION_DEFINITIONS) : []), ...(work?.definitions ?? [])],
      properties: mergeProperties(on.control ? CONTROL_PARAMETER_PROPERTIES : {}, work?.parameters ?? {}),
    }),
    toolSchema({
      name: VOICE_TOOLS.web,
      description: [
        ...(on.web ? [WEB_TOOL_DESCRIPTION] : []),
        ...(chrome ? [chromeToolDescription({ webTool: on.web, doTask })] : []),
        ...(computer ? [computer.description] : []),
      ].join(' '),
      definitions: [
        ...(on.web ? offeredUpstream(upstream, WEB_ACTION_DEFINITIONS) : []),
        ...(chrome?.definitions ?? []),
        ...(computer?.definitions ?? []),
      ],
      properties: mergeProperties(on.web ? WEB_PARAMETER_PROPERTIES : {}, chrome ? chromeToolParameters({ doTask }) : {}, computer?.parameters ?? {}),
    }),
    toolSchema({
      name: VOICE_TOOLS.voice,
      description: VOICE_TOOL_DESCRIPTION,
      definitions: voiceOnly,
      properties: mergeProperties(
        on.control ? { sessionId: CONTROL_PARAMETER_PROPERTIES.sessionId, directory: CONTROL_PARAMETER_PROPERTIES.directory } : {},
        chrome ? HOST_PARAMETER : {},
      ),
    }),
  ];
  const offered = tools.filter((tool) => tool.parameters.properties.action.enum.length > 0);
  return offered.length > 0 ? [...offered, END_TOOL] : offered;
};

export const voiceActionTitles = ({ upstream, registry }) => Object.fromEntries([
  ...offeredUpstream(upstream, [...CONTROL_ACTION_DEFINITIONS, ...WEB_ACTION_DEFINITIONS]),
  ...registry.definitions({ includeVoiceOnly: true }),
].map(({ action, title }) => [action, title]));

export const guardCall = (action, { readSeen = false, assistantSpokeBefore = false, pendingHost = null, chromeAllowed = false } = {}) => {
  if (action === 'chrome.allow_site' && chromeAllowed === true) return { ok: true, answer: { ...ALREADY_ALLOWED } };
  if (REFUSED_AFTER_READ.has(action) && readSeen) {
    return { refuse: { reasonCode: 'refused_after_read', error: `${action} is not run after something was read in the same turn; ask the person again and wait for their answer` } };
  }
  if (action === 'session.stop' && !assistantSpokeBefore) {
    return { refuse: { reasonCode: 'confirm_first', error: 'Ask the person to confirm stopping the session and wait for their answer before calling session.stop' } };
  }
  if (action === 'chrome.allow_site' && !pendingHost) {
    return { refuse: { reasonCode: 'not_requested', error: 'Chrome has not asked for permission in this conversation, so there is nothing to allow' } };
  }
  return { ok: true };
};

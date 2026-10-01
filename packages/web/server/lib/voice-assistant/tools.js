import {
  MITTRCRAFT_AGENT_TOOL_ACTION_DEFINITIONS,
  MITTRCRAFT_CHROME_ACTION_DEFINITIONS,
  MITTRCRAFT_COMPUTER_ACTION_DEFINITIONS,
  MITTRCRAFT_VOICE_ACTION_DEFINITIONS,
  MITTRCRAFT_WEB_ACTION_DEFINITIONS,
} from '../mittrcraft-control/actions.js';
import {
  CHROME_PARAMETER_PROPERTIES,
  CHROME_TOOL_DESCRIPTION,
  COMPUTER_PARAMETER_PROPERTIES,
  COMPUTER_TOOL_DESCRIPTION,
  CONTROL_PARAMETER_PROPERTIES,
  CONTROL_TOOL_DESCRIPTION,
  WEB_PARAMETER_PROPERTIES,
  WEB_TOOL_DESCRIPTION,
} from '../agent-tool/runtime.js';

const VOICE_TOOL_DESCRIPTION = 'Voice-only actions. session.stop stops a running MittrCraft session and needs a spoken yes from the person first. session.read_reply returns the latest assistant answer of sessionId as plain speakable text; prefer it over session.messages to tell the person what an agent produced. chrome.allow_site allows Chrome on every site for the rest of this conversation; call it with the host of the first site_approval_required result, only after you asked the person once whether you may use Chrome in this conversation and they clearly said yes. After that, never ask about Chrome or a site again in this conversation.';
const VOICE_OMITTED_PARAMETERS = new Set(['wait', 'timeout']);
const HOST_PARAMETER = { host: { type: 'string', description: 'Site host from the site_approval_required result, such as example.com' } };

const mergeProperties = (...groups) => {
  const merged = {};
  for (const group of groups) {
    for (const [name, schema] of Object.entries(group)) {
      const existing = merged[name];
      merged[name] = existing && existing.description !== schema.description
        ? { ...existing, description: `${existing.description}; ${schema.description}` }
        : { ...schema };
    }
  }
  return merged;
};

const pick = (properties, names) => Object.fromEntries(names.map((name) => [name, properties[name]]));

const switchesFrom = ({ chromeAvailable, computerAvailable, settings }) => ({
  control: settings?.agentControlToolEnabled !== false,
  web: settings?.agentWebToolEnabled !== false,
  chrome: chromeAvailable === true && settings?.agentChromeToolEnabled !== false,
  computer: computerAvailable === true && settings?.agentComputerToolEnabled !== false,
});

const END_TOOL = Object.freeze({
  name: 'mittrcraft_end',
  description: 'End this voice conversation, as if the person pressed End. Call it only when the person wants to stop talking with you altogether and asks for nothing else in the same sentence (bye, that is all, end the conversation, จบการสนทนา, เลิกคุย, บ๊ายบาย), with a one-sentence goodbye in the same reply. If they also ask for something, do that instead and keep talking.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
});

export const VOICE_END_TOOL_NAME = END_TOOL.name;
export const VOICE_END_TITLE = 'End the conversation';

const voiceToolDefinitions = (on) => ({
  mittrcraft: on.control ? MITTRCRAFT_AGENT_TOOL_ACTION_DEFINITIONS : [],
  mittrcraft_web: [
    ...(on.web ? MITTRCRAFT_WEB_ACTION_DEFINITIONS : []),
    ...(on.chrome ? MITTRCRAFT_CHROME_ACTION_DEFINITIONS : []),
    ...(on.computer ? MITTRCRAFT_COMPUTER_ACTION_DEFINITIONS : []),
  ],
  mittrcraft_voice: MITTRCRAFT_VOICE_ACTION_DEFINITIONS.filter(({ action }) => (action === 'chrome.allow_site' ? on.chrome : on.control)),
});

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

export const VOICE_ACTION_TITLES = Object.freeze(Object.fromEntries(
  Object.values(voiceToolDefinitions({ control: true, web: true, chrome: true, computer: true })).flat().map(({ action, title }) => [action, title]),
));

export const buildVoiceTools = ({ chromeAvailable = false, computerAvailable = false, settings = {} } = {}) => {
  const on = switchesFrom({ chromeAvailable, computerAvailable, settings });
  const definitions = voiceToolDefinitions(on);
  const tools = [
    toolSchema({
      name: 'mittrcraft',
      description: CONTROL_TOOL_DESCRIPTION,
      definitions: definitions.mittrcraft,
      properties: Object.fromEntries(Object.entries(CONTROL_PARAMETER_PROPERTIES).filter(([name]) => !VOICE_OMITTED_PARAMETERS.has(name))),
    }),
    toolSchema({
      name: 'mittrcraft_web',
      description: [
        ...(on.web ? [WEB_TOOL_DESCRIPTION] : []),
        ...(on.chrome ? [CHROME_TOOL_DESCRIPTION] : []),
        ...(on.computer ? [COMPUTER_TOOL_DESCRIPTION] : []),
      ].join(' '),
      definitions: definitions.mittrcraft_web,
      properties: mergeProperties(
        on.web ? WEB_PARAMETER_PROPERTIES : {},
        on.chrome ? CHROME_PARAMETER_PROPERTIES : {},
        on.computer ? COMPUTER_PARAMETER_PROPERTIES : {},
      ),
    }),
    toolSchema({
      name: 'mittrcraft_voice',
      description: VOICE_TOOL_DESCRIPTION,
      definitions: definitions.mittrcraft_voice,
      properties: {
        ...(on.control ? pick(CONTROL_PARAMETER_PROPERTIES, ['sessionId', 'directory']) : {}),
        ...(on.chrome ? HOST_PARAMETER : {}),
      },
    }),
  ];
  const offered = tools.filter((tool) => tool.parameters.properties.action.enum.length > 0);
  return offered.length > 0 ? [...offered, END_TOOL] : offered;
};

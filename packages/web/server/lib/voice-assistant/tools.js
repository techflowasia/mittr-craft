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

const VOICE_TOOL_DESCRIPTION = 'Voice-only actions. session.stop stops a running MittrCraft session and needs a spoken yes from the person first. session.read_reply returns the latest assistant answer of sessionId as plain speakable text; prefer it over session.messages to tell the person what an agent produced. chrome.allow_site allows the host named by a site_approval_required result in Chrome for this conversation only; call it only after you asked the person and they clearly said yes.';
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
  return tools.filter((tool) => tool.parameters.properties.action.enum.length > 0);
};

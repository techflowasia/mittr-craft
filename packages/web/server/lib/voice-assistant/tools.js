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

const VOICE_TOOL_DESCRIPTION = 'Stop a running MittrCraft session or read its latest answer aloud. session.stop needs a spoken yes from the person first. session.read_reply returns the latest assistant answer of sessionId as plain speakable text; prefer it over session.messages to tell the person what an agent produced.';

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

const webDefinitions = ({ chromeAvailable, computerAvailable }) => [
  ...MITTRCRAFT_WEB_ACTION_DEFINITIONS,
  ...(chromeAvailable ? MITTRCRAFT_CHROME_ACTION_DEFINITIONS : []),
  ...(computerAvailable ? MITTRCRAFT_COMPUTER_ACTION_DEFINITIONS : []),
];

const toolSchema = ({ name, description, definitions, properties, required = [] }) => ({
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
    required: ['action', ...required],
    additionalProperties: false,
  },
});

const voiceToolDefinitions = (availability) => ({
  mittrcraft: MITTRCRAFT_AGENT_TOOL_ACTION_DEFINITIONS,
  mittrcraft_web: webDefinitions(availability),
  mittrcraft_voice: MITTRCRAFT_VOICE_ACTION_DEFINITIONS,
});

export const VOICE_ACTION_TITLES = Object.freeze(Object.fromEntries(
  Object.values(voiceToolDefinitions({ chromeAvailable: true, computerAvailable: true })).flat().map(({ action, title }) => [action, title]),
));

export const buildVoiceTools = ({ chromeAvailable = false, computerAvailable = false } = {}) => {
  const definitions = voiceToolDefinitions({ chromeAvailable, computerAvailable });
  return [
    toolSchema({
      name: 'mittrcraft',
      description: CONTROL_TOOL_DESCRIPTION,
      definitions: definitions.mittrcraft,
      properties: CONTROL_PARAMETER_PROPERTIES,
    }),
    toolSchema({
      name: 'mittrcraft_web',
      description: [
        WEB_TOOL_DESCRIPTION,
        ...(chromeAvailable ? [CHROME_TOOL_DESCRIPTION] : []),
        ...(computerAvailable ? [COMPUTER_TOOL_DESCRIPTION] : []),
      ].join(' '),
      definitions: definitions.mittrcraft_web,
      properties: mergeProperties(
        WEB_PARAMETER_PROPERTIES,
        chromeAvailable ? CHROME_PARAMETER_PROPERTIES : {},
        computerAvailable ? COMPUTER_PARAMETER_PROPERTIES : {},
      ),
    }),
    toolSchema({
      name: 'mittrcraft_voice',
      description: VOICE_TOOL_DESCRIPTION,
      definitions: definitions.mittrcraft_voice,
      properties: pick(CONTROL_PARAMETER_PROPERTIES, ['sessionId', 'directory']),
      required: ['sessionId'],
    }),
  ];
};

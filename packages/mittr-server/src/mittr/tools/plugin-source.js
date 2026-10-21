import path from 'node:path';

import { writeEnginePlugin } from '../private-file.js';

export const TOOLS_PLUGIN_ID = 'mittrcraft-tools';

const SCHEMA_VERSION = 1;
const PLUGIN_DIR = path.join('engine-plugins', TOOLS_PLUGIN_ID);

const inputOf = ({ definitions, parameters }) => ({
  type: 'object',
  properties: {
    action: {
      type: 'string',
      oneOf: definitions.map(({ action, description }) => ({ const: action, description })),
      description: 'MittrCraft action to perform',
    },
    parameters: {
      type: 'object',
      properties: parameters ?? {},
      additionalProperties: false,
      description: 'Inputs for the action; use an empty object when none are needed',
    },
  },
  required: ['action'],
  additionalProperties: true,
});

const toolEntry = (tool, codeMode) => `      tools.add({
        name: ${JSON.stringify(tool.name)},
        description: ${JSON.stringify(tool.description)},
        options: { codemode: ${codeMode ? 'true' : 'false'} },
        input: ${JSON.stringify(inputOf(tool))},
        execute: (input, context) => call(${JSON.stringify(tool.name)}, input, context),
      })
`;

export const toolsPluginSource = ({ tools, codeMode }) => {
  const titles = Object.fromEntries(tools.flatMap((tool) => tool.definitions.map(({ action, title }) => [action, title])));
  return `const SCHEMA_VERSION = ${SCHEMA_VERSION}
const TITLES = ${JSON.stringify(titles)}

const call = async (tool, input, context) => {
  const requested = typeof input?.action === "string" ? input.action : ""
  const result = (content, action, ok) => ({
    content,
    metadata: { mittrcraft: { schemaVersion: SCHEMA_VERSION, action, description: Object.hasOwn(TITLES, action) ? TITLES[action] : action, ok } },
  })
  const failure = (error) => result(JSON.stringify({ schemaVersion: SCHEMA_VERSION, ok: false, action: requested, error }), requested, false)
  const endpoint = process.env.MITTRCRAFT_TOOLS_URL
  const token = process.env.MITTRCRAFT_TOOLS_TOKEN
  if (!endpoint || !token) return failure({ message: "The MittrCraft tools connection is unavailable", kind: "runtime" })
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ tool, input: input ?? {}, sessionID: context.sessionID }),
      signal: context.signal,
    })
    const content = await response.text()
    let answer = null
    try { answer = JSON.parse(content) } catch {}
    if (answer?.schemaVersion === SCHEMA_VERSION && typeof answer.ok === "boolean" && typeof answer.action === "string") {
      return result(content, answer.action, answer.ok)
    }
    return failure({ message: "MittrCraft returned an invalid response", kind: "runtime", status: response.status })
  } catch (error) {
    return failure({ message: error instanceof Error ? error.message : String(error), kind: "runtime" })
  }
}

export default {
  id: ${JSON.stringify(TOOLS_PLUGIN_ID)},
  setup: async (ctx) => {
    await ctx.tool.transform((tools) => {
${tools.map((tool) => toolEntry(tool, codeMode)).join('')}    })
  },
}
`;
};

export const toolsPluginDir = (dataDir) => path.join(dataDir, PLUGIN_DIR);

export const materializeToolsPlugin = ({ dataDir, source }) => writeEnginePlugin(toolsPluginDir(dataDir), source);

export const toolsFragment = (dir) => ({ plugins: [dir] });

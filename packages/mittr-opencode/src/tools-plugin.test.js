import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOLS_PLUGIN_ID, toolsPluginSource } from './tools-plugin.js';

const TOOLS = [
  {
    name: 'mittrcraft_chrome',
    description: 'Drive a Chrome page.',
    parameters: { url: { type: 'string', description: 'Page to open' } },
    definitions: [{ action: 'chrome.open', title: 'Open a page', description: 'Opens a page.' }],
  },
  {
    name: 'mittrcraft_computer',
    description: 'See the desktop.',
    parameters: { app: { type: 'string' } },
    definitions: [
      { action: 'computer.list_apps', title: 'List apps', description: 'Lists apps.' },
      { action: 'computer.open_app', title: 'Open an app', description: 'Opens an app.' },
    ],
  },
];

const loadPlugin = async (codeMode = false) => {
  const source = toolsPluginSource({ tools: TOOLS, codeMode });
  const plugin = (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default;
  const added = [];
  let transforms = 0;
  await plugin.setup({
    tool: {
      transform: async (fn) => {
        transforms += 1;
        fn({ add: (tool) => added.push(tool) });
      },
    },
  });
  return { plugin, added, transforms };
};

test('the engine loads the plugin and gets each tool from one transform', async () => {
  const { plugin, added, transforms } = await loadPlugin();
  assert.equal(plugin.id, TOOLS_PLUGIN_ID);
  assert.equal(transforms, 1);
  assert.deepEqual(added.map((tool) => tool.name), ['mittrcraft_chrome', 'mittrcraft_computer']);
  assert.deepEqual(added.map((tool) => tool.options), [{ codemode: false }, { codemode: false }]);
});

test('each tool carries plain JSON Schema with its own actions and parameters', async () => {
  const { added } = await loadPlugin();
  assert.deepEqual(added[1].input, {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        oneOf: [
          { const: 'computer.list_apps', description: 'Lists apps.' },
          { const: 'computer.open_app', description: 'Opens an app.' },
        ],
        description: 'MittrCraft action to perform',
      },
      parameters: {
        type: 'object',
        properties: { app: { type: 'string' } },
        additionalProperties: false,
        description: 'Inputs for the action; use an empty object when none are needed',
      },
    },
    required: ['action'],
    additionalProperties: true,
  });
  assert.deepEqual(added[0].input.properties.parameters.properties, TOOLS[0].parameters);
});

test('with Code Mode on every tool goes behind the execute tool', async () => {
  const { added } = await loadPlugin(true);
  assert.deepEqual(added.map((tool) => tool.options), [{ codemode: true }, { codemode: true }]);
});

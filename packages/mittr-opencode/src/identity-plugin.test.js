import assert from 'node:assert/strict';
import test from 'node:test';

import { IDENTITY_PLUGIN_ID, identityLine, identityPluginSource } from './identity-plugin.js';

// The opening lines of the OpenCode 2.0.22 system prompts, as the engine sends them.
const HARNESS = 'You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.';
const INTERACTIVE = 'You are opencode, an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.';
const CODING_AGENT = 'You are OpenCode, a coding agent that helps users with software engineering tasks. You are powered by {{MODEL_NAME}}, a large language model trained by Meta MSL.';

const loadPlugin = async () => {
  const source = identityPluginSource({ productName: 'MittrCraft' });
  const plugin = (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default;
  const hooks = new Map();
  await plugin.setup({ session: { hook: async (name, handler) => { hooks.set(name, handler); } } });
  return { plugin, hooks };
};

test('the plugin registers one handler on the context, generate and compaction hooks', async () => {
  const { plugin, hooks } = await loadPlugin();
  assert.equal(plugin.id, IDENTITY_PLUGIN_ID);
  assert.equal(IDENTITY_PLUGIN_ID, 'mittrcraft.identity');
  assert.deepEqual([...hooks.keys()], ['context', 'generate', 'compaction']);
  assert.equal(new Set(hooks.values()).size, 1);
});

test('the older interactive opening line becomes MittrCraft and paths stay as they are', async () => {
  const { hooks } = await loadPlugin();
  const o = { system: [{ text: 'You are opencode, an interactive CLI tool that helps… Use .opencode/agents.' }] };
  hooks.get('context')(o);
  assert.ok(o.system[0].text.startsWith('You are MittrCraft, an interactive tool'), o.system[0].text);
  assert.ok(o.system[0].text.includes('.opencode/agents'));
  assert.equal(o.system.length, 2);
  assert.ok(o.system[1].text.includes('answer MittrCraft'));
});

test('the 2.0.22 harness opening line becomes the MittrCraft line', async () => {
  const { hooks } = await loadPlugin();
  const o = { system: [{ type: 'text', text: `${HARNESS}\n\n# Harness\n- Read .opencode/agents first.` }] };
  hooks.get('context')(o);
  assert.equal(o.system[0].text, 'You are MittrCraft, an AI coding agent. Help the user accomplish their goals using the tools you have available.\n\n# Harness\n- Read .opencode/agents first.');
  assert.deepEqual(o.system[1], { type: 'text', text: identityLine('MittrCraft') });
});

test('the harness line is rewritten with whitespace around it and inside it', async () => {
  const { hooks } = await loadPlugin();
  const o = { system: [{ type: 'text', text: '\n  You are an AI agent running in OpenCode,  a coding\nagent harness.  \nHelp the user.' }] };
  hooks.get('context')(o);
  assert.equal(o.system[0].text, '\n  You are MittrCraft, an AI coding agent.  \nHelp the user.');
});

test('the coding-agent opening line becomes MittrCraft', async () => {
  const { hooks } = await loadPlugin();
  const o = { system: [{ type: 'text', text: CODING_AGENT }] };
  hooks.get('generate')(o);
  assert.ok(o.system[0].text.startsWith('You are MittrCraft, a coding agent that helps users'), o.system[0].text);
});

test('every system part loses the engine introduction, and none still introduces OpenCode', async () => {
  const { hooks } = await loadPlugin();
  const o = { system: [{ type: 'text', text: HARNESS }, { type: 'text', text: INTERACTIVE }, { type: 'text', text: 'Project rules.' }] };
  hooks.get('compaction')(o);
  const sent = o.system.map((part) => part.text).join('\n');
  assert.doesNotMatch(sent, /You are (an AI agent running in )?open ?code/i);
  assert.equal(o.system.at(-1).text, identityLine('MittrCraft'));
  assert.equal(o.system[2].text, 'Project rules.');
});

test('a handler that runs twice on the same prompt adds the identity line once', async () => {
  const { hooks } = await loadPlugin();
  const o = { system: [{ type: 'text', text: HARNESS }] };
  hooks.get('context')(o);
  hooks.get('generate')(o);
  assert.equal(o.system.filter((part) => part.text === identityLine('MittrCraft')).length, 1);
});

test('a prompt without a system list is left alone', async () => {
  const { hooks } = await loadPlugin();
  const o = { messages: [] };
  hooks.get('context')(o);
  assert.deepEqual(o, { messages: [] });
});

test('the identity line names the product and both upstream names it must not use', () => {
  assert.equal(
    identityLine('MittrCraft'),
    'You are MittrCraft. When asked who you are or which product this is, answer MittrCraft. Never call yourself OpenCode or OpenChamber.',
  );
});

test('a product name with replacement patterns is written literally', async () => {
  const source = identityPluginSource({ productName: 'A$&B' });
  const plugin = (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default;
  const hooks = new Map();
  await plugin.setup({ session: { hook: async (name, handler) => { hooks.set(name, handler); } } });
  const o = { system: [{ type: 'text', text: HARNESS }] };
  hooks.get('context')(o);
  assert.ok(o.system[0].text.startsWith('You are A$&B, an AI coding agent.'), o.system[0].text);
});

test('the source needs a product name', () => {
  assert.throws(() => identityPluginSource({ productName: '' }), /productName/);
});

test('a sentence quoted inside a part is left alone; only an opening one is rewritten', async () => {
  const { hooks } = await loadPlugin();
  const quoted = `# AGENTS.md\nThe engine starts its prompt with "${HARNESS}" and says "You are opencode, an interactive CLI tool".`;
  const skill = `Example:\n  You are OpenCode, a coding agent that helps users`;
  const o = { system: [{ type: 'text', text: HARNESS }, { type: 'text', text: quoted }, { type: 'text', text: skill }] };
  hooks.get('context')(o);
  assert.ok(o.system[0].text.startsWith('You are MittrCraft, an AI coding agent.'));
  assert.equal(o.system[1].text, quoted);
  assert.equal(o.system[2].text, skill);
});

test('only the opening sentence of a part is rewritten, not a repeat later in it', async () => {
  const { hooks } = await loadPlugin();
  const o = { system: [{ type: 'text', text: `${HARNESS}\nQuote: ${HARNESS}` }] };
  hooks.get('context')(o);
  assert.equal(o.system[0].text, `You are MittrCraft, an AI coding agent. Help the user accomplish their goals using the tools you have available.\nQuote: ${HARNESS}`);
});

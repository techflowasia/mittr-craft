/**
 * The engine plugin that makes the model introduce itself as the product.
 *
 * The engine opens its system prompt by naming itself. The harness prompt
 * says it runs in OpenCode, and the model-specific prompts it carries say it
 * is opencode or OpenCode (2.3.2 adds one for Kimi models). The plugin rewrites each of those sentences
 * where it opens a system part and adds one line that tells the model its
 * name. Built-in
 * tool and skill names, and paths such as `.opencode/`, are left alone: they
 * are how the engine finds its tools, not how the model introduces itself.
 *
 * Probe P3 (`scripts/mittr/probe-engine-v2.mjs`) proved that the engine runs the
 * `context` hook once for each turn and lets it rewrite the prompt. The same
 * handler is on `generate` and `compaction` too, so a prompt built on those
 * paths is rewritten the same way.
 */

export const IDENTITY_PLUGIN_ID = 'mittrcraft.identity';

const HOOKS = ['context', 'generate', 'compaction'];

/** Each sentence the engine introduces itself with, and what the model reads instead. */
const introductions = (productName) => [
  { from: 'You are an AI agent running in OpenCode, a coding agent harness.', to: `You are ${productName}, an AI coding agent.` },
  { from: 'You are opencode, an interactive CLI tool', to: `You are ${productName}, an interactive tool` },
  { from: 'You are OpenCode, a coding agent', to: `You are ${productName}, a coding agent` },
  { from: 'You are OpenCode, an interactive general AI agent', to: `You are ${productName}, an interactive general AI agent` },
];

export const identityLine = (productName) =>
  `You are ${productName}. When asked who you are or which product this is, answer ${productName}. Never call yourself OpenCode or OpenChamber.`;

// Only a part that opens with the sentence is rewritten: a project's
// AGENTS.md or a skill that quotes it later on keeps its text. A prompt may
// wrap the sentence or space it twice; any run of whitespace between two
// words still matches, and the whitespace before it is kept.
const openingPattern = (sentence) => `^(\\s*)${sentence
  .split(' ')
  .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('\\s+')}`;

/**
 * The plugin's ES module source, `export default { id, setup }`, written to a
 * directory the engine loads from its config.
 */
export const identityPluginSource = ({ productName }) => {
  if (!productName) throw new Error('identityPluginSource needs a productName');
  const rewrites = introductions(productName).map(({ from, to }) => [openingPattern(from), to]);
  return `const IDENTITY = ${JSON.stringify(identityLine(productName))}
const REWRITES = ${JSON.stringify(rewrites)}.map(([pattern, text]) => [new RegExp(pattern), text])
const COMPLETION = 'Task completion: For an approved execution request, continue with the next authorized action while work remains. Use progress messages for updates, not a final answer that merely lists next steps. End execution only when the requested work is complete, the user stops it, or a concrete blocker requires user input or permission. Investigate recoverable obstacles with available tools before declaring a blocker. Respect scope, safety, cost constraints and stop requests; do not replace required approval with autonomous continuation. Report verified results and unfinished items honestly; do not promise background work unless a real background operation is running. This instruction does not authorize automatic retries or unlimited continuation.'

const introduce = (o) => {
  if (!Array.isArray(o.system)) return
  for (const part of o.system) {
    if (part && typeof part.text === 'string') {
      part.text = REWRITES.reduce((text, [pattern, replacement]) => text.replace(pattern, (_, lead) => lead + replacement), part.text)
    }
  }
  if (!o.system.some((part) => part && part.text === IDENTITY)) o.system.push({ type: 'text', text: IDENTITY })
}

export default {
  id: ${JSON.stringify(IDENTITY_PLUGIN_ID)},
  setup: async (ctx) => {
    for (const hook of ${JSON.stringify(HOOKS)}) await ctx.session.hook(hook, (o) => {
      introduce(o)
      if (hook !== 'compaction' && Array.isArray(o.system) && !o.system.some((part) => part && part.text === COMPLETION)) {
        o.system.push({ type: 'text', text: COMPLETION })
      }
    })
  },
}
`;
};

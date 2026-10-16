/**
 * The engine plugin that makes the model introduce itself as the product.
 *
 * The engine opens its system prompt by naming itself. The 2.0.22 harness
 * prompt says it runs in OpenCode, and the older prompts it still carries say
 * it is opencode or OpenCode. The plugin rewrites each of those sentences in
 * every system part and adds one line that tells the model its name. Built-in
 * tool and skill names, and paths such as `.opencode/`, are left alone: they
 * are how the engine finds its tools, not how the model introduces itself.
 *
 * Probe P3 (`scripts/mittr/probe-engine-v2.mjs`) proved that 2.0.22 runs the
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
];

export const identityLine = (productName) =>
  `You are ${productName}. When asked who you are or which product this is, answer ${productName}. Never call yourself OpenCode or OpenChamber.`;

// A prompt may wrap a sentence or space it twice; any run of whitespace
// between two words still matches.
const sentencePattern = (sentence) => sentence
  .split(' ')
  .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('\\s+');

/**
 * The plugin's ES module source, `export default { id, setup }`, written to a
 * directory the engine loads from its config.
 */
export const identityPluginSource = ({ productName }) => {
  if (!productName) throw new Error('identityPluginSource needs a productName');
  const rewrites = introductions(productName).map(({ from, to }) => [sentencePattern(from), to]);
  return `const IDENTITY = ${JSON.stringify(identityLine(productName))}
const REWRITES = ${JSON.stringify(rewrites)}.map(([pattern, text]) => [new RegExp(pattern, 'g'), text])

const introduce = (o) => {
  if (!Array.isArray(o.system)) return
  for (const part of o.system) {
    if (part && typeof part.text === 'string') {
      part.text = REWRITES.reduce((text, [pattern, replacement]) => text.replace(pattern, () => replacement), part.text)
    }
  }
  if (!o.system.some((part) => part && part.text === IDENTITY)) o.system.push({ type: 'text', text: IDENTITY })
}

export default {
  id: ${JSON.stringify(IDENTITY_PLUGIN_ID)},
  setup: async (ctx) => {
    for (const hook of ${JSON.stringify(HOOKS)}) await ctx.session.hook(hook, introduce)
  },
}
`;
};

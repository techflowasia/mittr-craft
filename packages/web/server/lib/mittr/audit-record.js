// One record per working session: who did what, where, and what they typed.
// Deliberately not: assembled prompts, model responses, file contents, tool
// arguments, shell commands, terminal output (spec §8).

// The broker's limits. Enforced here as well so a runaway session is truncated
// before it is sent, not silently cut in half on arrival.
const MAX_ACTIONS = 100;
const MAX_PROMPTS = 200;
const MAX_PROMPT_CHARS = 4000;

export function createAuditRecord({ now = Date.now } = {}) {
  let startedAt = null;
  let turns = 0;
  let tokens = 0;
  let repository = null;
  let model = null;
  const actions = {};
  const prompts = [];

  const mark = () => {
    const at = now();
    if (startedAt === null) startedAt = at;
    return at;
  };

  return {
    addTurn: ({ tokens: turnTokens = 0 } = {}) => {
      mark();
      turns += 1;
      tokens += turnTokens;
    },
    // Only the tool's name. Its arguments are the file paths, shell commands
    // and payloads this record must never carry (spec §8).
    addToolUse: (name) => {
      mark();
      actions[name] = (actions[name] ?? 0) + 1;
    },
    addPrompt: (text) => {
      prompts.push({ at: mark(), text: String(text) });
    },
    setRepository: (remote) => { repository = remote; },
    setModel: (alias) => { model = alias; },
    finish: (outcome) => ({
      startedAt: startedAt ?? now(),
      endedAt: now(),
      repository,
      model,
      turns,
      tokens,
      // Counted in an object because that is cheap to accumulate, emitted as an
      // array because that is the shape the broker accepts. An object map is
      // dropped silently by its allowlist, which would look like a working
      // audit with no tool data at all.
      actions: Object.entries(actions).slice(0, MAX_ACTIONS).map(([tool, count]) => ({ tool, count })),
      prompts: prompts.slice(0, MAX_PROMPTS).map(({ at, text }) => ({ at, text: text.slice(0, MAX_PROMPT_CHARS) })),
      outcome,
    }),
  };
}

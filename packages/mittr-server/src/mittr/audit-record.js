const MAX_ACTIONS = 100;
const MAX_PROMPTS = 200;
const MAX_PROMPT_CHARS = 4000;

export function createAuditRecord({ now = Date.now } = {}) {
  let startedAt = null;
  let turns = 0;
  let tokens = 0;
  let repository = null;
  let model = null;
  const actions = new Map();
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
    addToolUse: (name) => {
      mark();
      if (actions.has(name)) actions.set(name, actions.get(name) + 1);
      else if (actions.size < MAX_ACTIONS) actions.set(name, 1);
    },
    addPrompt: (text) => {
      const at = mark();
      if (prompts.length < MAX_PROMPTS) prompts.push({ at, text: String(text).slice(0, MAX_PROMPT_CHARS) });
    },
    setRepository: (identity) => { repository = identity; },
    setModel: (alias) => { model = alias; },
    finish: (outcome) => ({
      startedAt: startedAt ?? now(),
      endedAt: now(),
      repository,
      model,
      turns,
      tokens,
      actions: [...actions].map(([tool, count]) => ({ tool, count })),
      prompts: prompts.map(({ at, text }) => ({ at, text })),
      outcome,
    }),
  };
}

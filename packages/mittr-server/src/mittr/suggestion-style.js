export const NEXT_STEP_SUGGESTION_RULES = Object.freeze([
  'suggestion: write ONE immediately sendable next user message addressed TO the coding agent.',
  'The suggestion should be the most useful next step after the assistant\'s latest reply. It should help the user continue productively, not inspect already-known details.',
  'Prefer suggestions that ask the agent to make a concrete improvement, implement something specific, validate the latest change, explain tradeoffs, improve the current approach, or continue from the current result.',
  'Rules for suggestion:',
  '- Output exactly one message the user could click and send without editing.',
  '- Pick one best next action yourself.',
  '- Do not include alternatives, choices, slash-separated options, or "or".',
  '- Do not write "Do X or Y", "Ask whether...", "Maybe...", or "You could...".',
  '- Do not ask for information the assistant already provided.',
  '- Do not ask to see exact code, file paths, prompt locations, or implementation internals unless the assistant did not provide them and they are necessary for the next step.',
  '- Do not produce generic workflow commands like "Run tests" unless testing is clearly the next unresolved step.',
  '- Do not produce meta/debug requests that merely inspect the implementation.',
  '- Use imperative or question form.',
  '- Keep it concise.',
  'Use these examples to understand how to choose the suggestion. Do not copy their topic or wording unless the current conversation is about the same thing.',
  'Example 1:',
  'Assistant reply summary:',
  'The assistant already identified the file where the feature is implemented, explained what context is sent to the small model, and summarized the current prompt.',
  'Bad suggestion:',
  '"Show me the exact runtime.js code and where the prompt is built."',
  'Why bad:',
  'It asks for information the assistant already provided. It repeats inspection instead of moving to an improvement or decision.',
  'Good suggestion:',
  '"Suggest how to improve the prompt and context so the generated suggestion is more useful."',
  'Why good:',
  'It naturally continues from the analysis and asks for a concrete improvement.',
  'Example 2:',
  'Assistant reply summary:',
  'The assistant implemented a timeline dialog redesign, listed concrete UI changes, and reported that type-check and lint passed.',
  'Bad suggestion:',
  '"Check whether scrolling or loading older messages works without jumps."',
  'Why bad:',
  'It contains an alternative. A suggestion chip must be one sendable message, not a choice the user has to edit.',
  'Good suggestion:',
  '"Check whether scrolling and loading older messages work without jumps."',
  'Why good:',
  'It picks a single validation request that the user can send immediately.',
]);

const NO_HOOK = 'this server cannot take a suggestion style, so suggestions stay upstream\'s';

export function createSuggestionStyle({ register, logger = console }) {
  let unregister = null;
  let disposed = false;
  let warnedMissing = false;

  const clear = () => {
    unregister?.();
    unregister = null;
  };

  const apply = (style) => {
    if (style === 'unfinished-only' || disposed) {
      clear();
      return true;
    }
    if (unregister) return true;
    if (typeof register !== 'function') {
      if (!warnedMissing) {
        warnedMissing = true;
        logger.warn(`[mittr] ${NO_HOOK}`);
      }
      return false;
    }
    try {
      unregister = register({ suggestionRules: () => NEXT_STEP_SUGGESTION_RULES });
      return true;
    } catch (error) {
      logger.warn('[mittr] could not set the next-step suggestions:', error?.message ?? error);
      return false;
    }
  };

  let changes = 0;

  const change = (style) => {
    changes += 1;
    return apply(style);
  };

  const load = async (read) => {
    const before = changes;
    let style = 'next-step';
    try {
      style = (await read()).suggestionStyle;
    } catch (error) {
      logger.warn('[mittr] could not read the suggestion setting; next-step suggestions stay on:', error?.message ?? error);
    }
    if (changes === before) apply(style);
  };

  const dispose = () => {
    disposed = true;
    clear();
  };

  return { apply: change, load, dispose };
}

import { afterEach, describe, expect, it } from 'vitest';
import { buildAssistSystemPrompt, registerSuggestionStyle } from './prompt.js';

const TARGETS = [
  { recap: true, suggestion: true },
  { recap: true, suggestion: false },
  { recap: false, suggestion: true },
  { recap: false, suggestion: false },
];

const UPSTREAM_SUGGESTION_LINES = [
  'suggestion is optional. Return "" when the current request is satisfied or continuing requires a user decision.',
  'suggestion: return an empty string if the latest request has been satisfied',
  'Otherwise write one concise, specific next message the user can send unchanged to continue the unfinished request.',
  'A request to analyze, explain, or recommend is satisfied by that analysis',
  'Only suggest work the coding agent can perform in the session.',
];

const RULES = ['suggestion: write one next message for the agent.', 'Keep it short.'];

const unregisters = [];
const register = (style) => {
  const unregister = registerSuggestionStyle(style);
  unregisters.push(unregister);
  return unregister;
};

afterEach(() => {
  while (unregisters.length) unregisters.pop()();
});

describe('session assist suggestion style', () => {
  it('without a registered style the prompt keeps the built-in suggestion instructions', () => {
    const prompt = buildAssistSystemPrompt({ recap: true, suggestion: true });
    for (const line of UPSTREAM_SUGGESTION_LINES) expect(prompt).toContain(line);
  });

  it('a registered style replaces only the suggestion instructions', () => {
    const before = buildAssistSystemPrompt({ recap: true, suggestion: true }).split('\n');
    register({ suggestionRules: () => RULES });
    const after = buildAssistSystemPrompt({ recap: true, suggestion: true }).split('\n');

    for (const line of UPSTREAM_SUGGESTION_LINES) expect(after.join('\n')).not.toContain(line);
    const kept = before.filter((line) => !UPSTREAM_SUGGESTION_LINES.some((upstream) => line.startsWith(upstream)));
    expect(after.filter((line) => !RULES.includes(line))).toEqual(kept);
    expect(after[0]).toBe('Return exactly one JSON object with string fields: "recap", "suggestion".');
    expect(after.indexOf(RULES[0])).toBe(before.findIndex((line) => line.startsWith(UPSTREAM_SUGGESTION_LINES[0])));
    expect(after.slice(after.indexOf(RULES[0]), after.indexOf(RULES[0]) + RULES.length)).toEqual(RULES);
  });

  it('the rules are read again for every prompt', () => {
    let rules = RULES;
    register({ suggestionRules: () => rules });
    expect(buildAssistSystemPrompt({ recap: false, suggestion: true })).toContain(RULES[1]);
    rules = ['suggestion: a different rule.'];
    const prompt = buildAssistSystemPrompt({ recap: false, suggestion: true });
    expect(prompt).toContain('suggestion: a different rule.');
    expect(prompt).not.toContain(RULES[1]);
  });

  it('a prompt without the suggestion field ignores the style and does not ask it', () => {
    const before = buildAssistSystemPrompt({ recap: true, suggestion: false });
    let asked = 0;
    register({ suggestionRules: () => { asked += 1; return RULES; } });
    expect(buildAssistSystemPrompt({ recap: true, suggestion: false })).toBe(before);
    expect(buildAssistSystemPrompt({ recap: false, suggestion: false })).not.toContain(RULES[0]);
    expect(asked).toBe(0);
  });

  it('rules that throw, are empty or are not a list of text fall back to the built-in instructions', () => {
    const before = TARGETS.map((targets) => buildAssistSystemPrompt(targets));
    for (const suggestionRules of [
      () => { throw new Error('broken'); },
      () => [],
      () => null,
      () => 'one rule',
      () => ['ok', 3],
      () => ['ok', '  '],
    ]) {
      const unregister = registerSuggestionStyle({ suggestionRules });
      try {
        expect(TARGETS.map((targets) => buildAssistSystemPrompt(targets))).toEqual(before);
      } finally {
        unregister();
      }
    }
  });

  it('unregistering restores the prompt exactly', () => {
    const before = TARGETS.map((targets) => buildAssistSystemPrompt(targets));
    const unregister = registerSuggestionStyle({ suggestionRules: () => RULES });
    expect(TARGETS.map((targets) => buildAssistSystemPrompt(targets))).not.toEqual(before);
    unregister();
    expect(TARGETS.map((targets) => buildAssistSystemPrompt(targets))).toEqual(before);
  });

  it('one style at a time, and an old unregister does not remove a newer style', () => {
    const first = registerSuggestionStyle({ suggestionRules: () => RULES });
    expect(() => registerSuggestionStyle({ suggestionRules: () => RULES })).toThrow();
    first();
    first();
    register({ suggestionRules: () => ['suggestion: the newer rule.'] });
    first();
    expect(buildAssistSystemPrompt({ recap: false, suggestion: true })).toContain('suggestion: the newer rule.');
  });

  it('a style without suggestionRules is refused', () => {
    for (const style of [null, undefined, {}, { suggestionRules: RULES }]) {
      expect(() => registerSuggestionStyle(style)).toThrow(TypeError);
    }
    expect(buildAssistSystemPrompt({ recap: false, suggestion: true })).toContain(UPSTREAM_SUGGESTION_LINES[0]);
  });
});

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { repoRoot } from '../upstream-contract.js';
import { createSuggestionStyle, NEXT_STEP_SUGGESTION_RULES } from './suggestion-style.js';

const upstreamPrompt = () => import(pathToFileURL(path.join(repoRoot, 'packages/web/server/lib/session-assist/prompt.js')).href);

const recordingLogger = () => {
  const warnings = [];
  return { warnings, log: () => {}, warn: (...args) => warnings.push(args.join(' ')) };
};

const fakeRegistry = () => {
  const active = [];
  let registrations = 0;
  return {
    active,
    registrations: () => registrations,
    register: (style) => {
      registrations += 1;
      active.push(style);
      return () => {
        const index = active.indexOf(style);
        if (index >= 0) active.splice(index, 1);
      };
    },
  };
};

test('the next-step rules are the 1.22 suggestion rules with their examples', () => {
  assert.equal(NEXT_STEP_SUGGESTION_RULES[0], 'suggestion: write ONE immediately sendable next user message addressed TO the coding agent.');
  assert.ok(NEXT_STEP_SUGGESTION_RULES.includes("The suggestion should be the most useful next step after the assistant's latest reply. It should help the user continue productively, not inspect already-known details."));
  assert.ok(NEXT_STEP_SUGGESTION_RULES.includes('- Do not include alternatives, choices, slash-separated options, or "or".'));
  assert.equal(NEXT_STEP_SUGGESTION_RULES.at(-1), 'It picks a single validation request that the user can send immediately.');
  assert.equal(NEXT_STEP_SUGGESTION_RULES.length, 37);
  assert.ok(NEXT_STEP_SUGGESTION_RULES.every((rule) => typeof rule === 'string' && rule.trim() !== ''));
  assert.ok(Object.isFrozen(NEXT_STEP_SUGGESTION_RULES));
});

test('next-step registers the rules once, and unfinished-only registers nothing', () => {
  const registry = fakeRegistry();
  const style = createSuggestionStyle({ register: registry.register, logger: recordingLogger() });
  assert.equal(registry.active.length, 0);

  assert.equal(style.apply('next-step'), true);
  assert.equal(style.apply('next-step'), true);
  assert.equal(registry.registrations(), 1);
  assert.deepEqual(registry.active[0].suggestionRules(), NEXT_STEP_SUGGESTION_RULES);

  assert.equal(style.apply('unfinished-only'), true);
  assert.equal(registry.active.length, 0);
  assert.equal(style.apply('unfinished-only'), true);
  assert.equal(registry.registrations(), 1);

  style.apply('next-step');
  assert.equal(registry.active.length, 1);
  style.dispose();
  assert.equal(registry.active.length, 0);
  style.apply('next-step');
  assert.equal(registry.active.length, 0, 'nothing registers after dispose');
});

test('a style name it does not know is the next-step default', () => {
  const registry = fakeRegistry();
  const style = createSuggestionStyle({ register: registry.register, logger: recordingLogger() });
  style.apply('something-else');
  assert.equal(registry.active.length, 1);
});

test('a server without the hook, or a registration that throws, is logged and leaves upstream suggestions', () => {
  const logger = recordingLogger();
  const missing = createSuggestionStyle({ register: undefined, logger });
  assert.equal(missing.apply('next-step'), false);
  assert.equal(missing.apply('unfinished-only'), true);
  assert.equal(logger.warnings.length, 1);

  const throwing = createSuggestionStyle({ register: () => { throw new Error('taken'); }, logger });
  assert.equal(throwing.apply('next-step'), false);
  assert.ok(logger.warnings.at(-1).includes('taken'));
});

test('registered through upstream, next-step puts the 1.22 rules in the prompt and unfinished-only restores upstream', async () => {
  const { buildAssistSystemPrompt, registerSuggestionStyle } = await upstreamPrompt();
  const upstream = buildAssistSystemPrompt({ recap: true, suggestion: true });
  const style = createSuggestionStyle({ register: registerSuggestionStyle, logger: recordingLogger() });
  try {
    style.apply('next-step');
    const prompt = buildAssistSystemPrompt({ recap: true, suggestion: true });
    assert.ok(prompt.includes(NEXT_STEP_SUGGESTION_RULES.join('\n')));
    assert.ok(!prompt.includes('Only suggest work the coding agent can perform in the session.'));
    assert.ok(prompt.includes('Return exactly one JSON object with string fields: "recap", "suggestion".'));
    assert.equal(buildAssistSystemPrompt({ recap: true, suggestion: false }), buildAssistSystemPrompt({ recap: true, suggestion: false }));
    style.apply('unfinished-only');
    assert.equal(buildAssistSystemPrompt({ recap: true, suggestion: true }), upstream);
  } finally {
    style.dispose();
  }
  assert.equal(buildAssistSystemPrompt({ recap: true, suggestion: true }), upstream);
});

test('load applies the stored style, unless a change was applied while it was reading', async () => {
  const registry = fakeRegistry();
  const logger = recordingLogger();
  const stored = createSuggestionStyle({ register: registry.register, logger });
  await stored.load(async () => ({ suggestionStyle: 'unfinished-only' }));
  assert.equal(registry.active.length, 0);
  await stored.load(async () => ({ suggestionStyle: 'next-step' }));
  assert.equal(registry.active.length, 1);
  stored.dispose();

  const raced = createSuggestionStyle({ register: registry.register, logger });
  let finish;
  const loading = raced.load(() => new Promise((resolve) => { finish = resolve; }));
  raced.apply('unfinished-only');
  finish({ suggestionStyle: 'next-step' });
  await loading;
  assert.equal(registry.active.length, 0, 'the older read does not undo the newer change');

  const unreadable = createSuggestionStyle({ register: registry.register, logger });
  await unreadable.load(async () => { throw new Error('damaged'); });
  assert.equal(registry.active.length, 1, 'settings that cannot be read leave the next-step default');
  assert.ok(logger.warnings.at(-1).includes('damaged'));
  unreadable.dispose();
});

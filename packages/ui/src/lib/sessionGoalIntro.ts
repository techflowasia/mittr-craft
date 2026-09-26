import { wrapSystemReminder } from '@/lib/systemReminder';

const GOAL_METHOD_LINES = [
  'Mittr goal is active for this session. The user message above states the requirements. Work until they are really done: after every turn an independent judge checks each requirement against the record of your tool calls and sends you back with what is missing.',
  'Method:',
  '1. Brief. Investigate before asking: read the workspace, the files and the web. Ask the person only what decides the outcome and cannot be found or safely defaulted, once and briefly, with the question tool. If the requirements are clear, ask nothing and start.',
  '2. Plan the work with todowrite and keep it current.',
  '3. Research what you do not know with websearch and webfetch. Cite only pages you actually opened.',
  '4. Do the work, then verify it with real checks: run the tests or the build, run the script, open and re-read what you produced. When a check fails, act on the error signal and fix the cause; do not work around it and do not stop.',
  '5. Only your tool calls count as evidence. Never say something is done, passing or sourced unless a tool call in this session shows it.',
  '6. End every turn with a goal report: each requirement, its state (done, not done, needs the person) and its evidence (command and result, file path, URL opened).',
];

export const buildGoalIntro = (tokenBudget: number | null): string => wrapSystemReminder([
  ...GOAL_METHOD_LINES,
  ...(tokenBudget ? [`A token budget of ${tokenBudget} tokens applies to this goal.`] : []),
].join('\n'));

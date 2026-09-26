import { GOAL_OBJECTIVE_CHAR_LIMIT, writeObjective } from './objectives.js';

const TRIM_MARKER = '\n\n[… objective trimmed for the auditor — the full prompt was delivered in the chat message …]\n\n';

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

export const buildGoalIntroText = (tokenBudget) => {
  const budgetLine = tokenBudget
    ? [`A token budget of ${tokenBudget} tokens applies to this goal.`]
    : [];
  return ['<system-reminder>', ...GOAL_METHOD_LINES, ...budgetLine, '</system-reminder>'].join('\n');
};

const fitObjective = async ({ objective, directory, providerID, modelID, warn }) => {
  if (objective.length <= GOAL_OBJECTIVE_CHAR_LIMIT) return objective;

  let distilled = null;
  try {
    const { generateSmallModelText } = await import('../small-model/index.js');
    const generated = await generateSmallModelText({
      restrictToPreferredProvider: true,
      prompt: objective,
      system: [
        'You distill a large task description into the COMPLETION CRITERIA a progress auditor will judge against.',
        'Return ONLY the criteria text — no preamble, no headers, no markdown fences.',
        'Capture: the end goals, what must exist and work when the task is fully done, and how each major part is verified. Omit implementation steps.',
        'Preserve verbatim any file paths, commands, and identifiers that define the task.',
        'Stay under 4000 characters.',
        'Write in the same language as the task text.',
      ].join('\n'),
      directory,
      preferredProviderID: providerID,
      preferredModelID: modelID,
    });
    distilled = typeof generated?.text === 'string' ? generated.text.trim() : null;
  } catch (error) {
    warn('goal objective distillation failed', error);
  }

  if (distilled) return distilled.slice(0, GOAL_OBJECTIVE_CHAR_LIMIT);
  const half = Math.max(0, Math.floor((GOAL_OBJECTIVE_CHAR_LIMIT - TRIM_MARKER.length) / 2));
  return `${objective.slice(0, half)}${TRIM_MARKER}${objective.slice(-half)}`;
};

export const createSessionGoal = async ({
  baseUrl,
  authHeaders,
  sessionID,
  directory,
  objective,
  tokenBudget = null,
  providerID,
  modelID,
  onWarning,
}) => {
  const warn = (message, error) => {
    if (typeof onWarning === 'function') {
      onWarning(message, error);
      return;
    }
    console.warn(`[session-goal] ${message}:`, error?.message || error);
  };
  const objectiveText = await fitObjective({
    objective: String(objective ?? '').trim(),
    directory,
    providerID,
    modelID,
    warn,
  });
  if (!objectiveText) throw new Error('goal objective is required');

  let objectiveFile = false;
  try {
    await writeObjective(sessionID, objectiveText);
    objectiveFile = true;
  } catch (error) {
    warn('goal objective file write failed, falling back to inline', error);
  }

  const now = Date.now();
  const goal = {
    id: `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    objective: objectiveFile ? '' : objectiveText.slice(0, GOAL_OBJECTIVE_CHAR_LIMIT),
    objectiveFile,
    status: 'active',
    tokenBudget: tokenBudget || null,
    tokensUsed: 0,
    turnsUsed: 0,
    blockedStreak: 0,
    note: '',
    statusReason: '',
    lastAccountedMessageID: '',
    createdAt: now,
    updatedAt: now,
  };
  const url = new URL(`${baseUrl}/session/${encodeURIComponent(sessionID)}`);
  url.searchParams.set('directory', directory);
  const response = await fetch(url.toString(), {
    method: 'PATCH',
    headers: {
      ...authHeaders,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ metadata: { mittrcraft: { goal } } }),
  });
  if (!response.ok) throw new Error(`goal metadata patch failed (${response.status})`);
  return goal;
};

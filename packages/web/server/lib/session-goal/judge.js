import fs from 'fs';

import { runScriptCheck, SCRIPT_CHECKS } from './checks.js';
import { withVerdict } from './contract.js';
import { escapeXmlText, extractJsonObject } from './structured.js';

const VERDICTS = ['met', 'missing', 'needs_person'];

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'verdict', 'why'],
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: VERDICTS },
          why: { type: 'string' },
        },
      },
    },
  },
};

const JUDGE_SYSTEM = [
  'You are the independent judge of whether an agent has really finished a person\'s goal. You judge each acceptance criterion separately, from the record of the tool calls made in this goal.',
  'Return exactly one JSON object: {"results": [{"id", "verdict", "why"}]} with one entry per criterion.',
  'verdict:',
  '- "met": the tool record shows the outcome was produced in this goal, and nothing later in the record undoes it or shows it failing.',
  '- "missing": the record does not show it, shows it failing, or only the agent\'s own report says so. The agent\'s report is a claim, never evidence.',
  '- "needs_person": only the person can make progress on it — a credential or access the agent does not have, or a choice the requirements leave open that the agent cannot reasonably make.',
  'why: one short sentence naming the evidence, or what is missing from it.',
].join('\n');

const buildJudgePrompt = ({ objective, criteria, evidence }) => [
  '<goal>',
  escapeXmlText(objective),
  '</goal>',
  '',
  'Acceptance criteria:',
  ...criteria.map((criterion) => `- ${criterion.id}: ${escapeXmlText(criterion.text)}`),
  '',
  'Tool record (authoritative, written by the system):',
  '<tool_record>',
  escapeXmlText(evidence.digest),
  '</tool_record>',
  '',
  'The agent\'s own report (a claim):',
  '<agent_report>',
  escapeXmlText(evidence.report || '(no report)'),
  '</agent_report>',
].join('\n');

const judgeWithModel = async ({ service, objective, criteria, evidence, directory, providerID, modelID }) => {
  const generated = await service.generateSmallModelText({
    restrictToPreferredProvider: true,
    system: JUDGE_SYSTEM,
    prompt: buildJudgePrompt({ objective, criteria, evidence }),
    responseSchema: JUDGE_SCHEMA,
    directory,
    preferredProviderID: providerID || undefined,
    preferredModelID: modelID || undefined,
  });
  const structured = extractJsonObject(generated?.text);
  const results = Array.isArray(structured?.results) ? structured.results : [];
  return {
    results: results
      .filter((entry) => typeof entry?.id === 'string' && VERDICTS.includes(entry.verdict))
      .map((entry) => ({ id: entry.id, verdict: entry.verdict, why: typeof entry.why === 'string' ? entry.why : '' })),
    providerID: generated?.providerID ?? '',
    modelID: generated?.modelID ?? '',
  };
};

export const createCriteriaEvaluator = ({ getMittrGoalJudge, getSmallModelService, fsImpl = fs }) => {
  const warn = (message, error) => console.warn(`[session-goal] ${message}:`, error?.message || error);

  return async ({ objective, criteria, evidence, directory, providerID, modelID }) => {
    const verdicts = new Map();
    let evaluation = null;

    for (const criterion of criteria) {
      if (!SCRIPT_CHECKS.has(criterion.check.type)) continue;
      const result = await runScriptCheck(criterion, { directory, evidence, fsImpl });
      if (result) verdicts.set(criterion.id, { ...result, by: 'script' });
    }

    const open = () => criteria.filter((criterion) => !verdicts.has(criterion.id));

    const mittr = typeof getMittrGoalJudge === 'function' ? getMittrGoalJudge() : null;
    if (open().length > 0 && mittr) {
      const asked = open();
      try {
        const answer = await mittr.judge({
          objective,
          criteria: asked.map(({ id, text }) => ({ id, text })),
          evidence: evidence.digest,
          report: evidence.report,
        });
        const askedIds = new Set(asked.map((criterion) => criterion.id));
        for (const result of answer.results) {
          if (!askedIds.has(result.id) || !VERDICTS.includes(result.verdict)) continue;
          verdicts.set(result.id, { status: result.verdict, reason: result.why, by: 'mittr' });
        }
        evaluation = { providerID: 'mittr', modelID: answer.decidedBy.join(', ') };
      } catch (error) {
        warn('Mittr judge unavailable, falling back to the session model', error);
      }
    }

    if (open().length > 0) {
      try {
        const service = await getSmallModelService();
        const answer = await judgeWithModel({
          service, objective, criteria: open(), evidence, directory, providerID, modelID,
        });
        const openIds = new Set(open().map((criterion) => criterion.id));
        for (const result of answer.results) {
          if (!openIds.has(result.id)) continue;
          verdicts.set(result.id, { status: result.verdict, reason: result.why, by: 'model' });
        }
        evaluation = { providerID: answer.providerID, modelID: answer.modelID };
      } catch (error) {
        if (Number(error?.statusCode) !== 404) warn('model judge failed', error);
      }
    }

    return {
      criteria: criteria.map((criterion) => (
        verdicts.has(criterion.id) ? withVerdict(criterion, verdicts.get(criterion.id)) : criterion
      )),
      unresolved: open().map((criterion) => criterion.id),
      evaluation,
    };
  };
};

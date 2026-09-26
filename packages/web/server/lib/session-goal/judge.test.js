import { describe, expect, it, vi } from 'vitest';

import { collectGoalEvidence } from './evidence.js';
import { createCriteriaEvaluator } from './judge.js';

const criteria = [
  { id: 'c1', text: 'Tests pass', check: { type: 'command', command: 'bun test' }, status: 'pending', reason: '', by: '' },
  { id: 'c2', text: 'The README explains setup', check: { type: 'judge' }, status: 'pending', reason: '', by: '' },
];

const evidence = collectGoalEvidence([{
  info: { id: 'msg_a', role: 'assistant', time: { created: 1 } },
  parts: [{ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'bun test' }, output: 'ok', metadata: { exit: 0 } } }],
}]);

const modelService = (results) => ({
  generateSmallModelText: vi.fn(async () => ({ text: JSON.stringify({ results }), providerID: 'p', modelID: 'm' })),
});

describe('criteria evaluator', () => {
  it('asks Mittr to confirm a passed script criterion with the check result, and to judge the rest', async () => {
    const judge = vi.fn(async () => ({
      results: [{ id: 'c1', verdict: 'met', why: 'run #1 passed' }, { id: 'c2', verdict: 'met', why: 'README written' }],
      decidedBy: ['jev'],
    }));
    const service = modelService([]);
    const evaluate = createCriteriaEvaluator({ getMittrGoalJudge: () => ({ judge }), getSmallModelService: async () => service });

    const result = await evaluate({ objective: 'o', criteria, evidence, directory: '/w' });

    expect(judge).toHaveBeenCalledOnce();
    const asked = judge.mock.calls[0][0].criteria;
    expect(asked.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(asked[0].text).toMatch(/^Tests pass \(automatic check passed: .*bun test/);
    expect(asked[1]).toEqual({ id: 'c2', text: 'The README explains setup' });
    expect(service.generateSmallModelText).not.toHaveBeenCalled();
    expect(result.criteria.map((c) => [c.id, c.status, c.by])).toEqual([['c1', 'met', 'mittr'], ['c2', 'met', 'mittr']]);
    expect(result.unresolved).toEqual([]);
    expect(result.evaluation).toEqual({ providerID: 'mittr', modelID: 'jev' });
  });

  it('keeps a criterion missing when its script passes but the rest of what it states is not shown', async () => {
    const constrained = [{ ...criteria[0], text: 'Tests pass without editing the tests' }];
    const judge = vi.fn(async () => ({ results: [{ id: 'c1', verdict: 'missing', why: 'test file edited in #3' }], decidedBy: ['jev'] }));
    const evaluate = createCriteriaEvaluator({ getMittrGoalJudge: () => ({ judge }), getSmallModelService: async () => modelService([]) });

    const result = await evaluate({ objective: 'o', criteria: constrained, evidence, directory: '/w' });

    expect(result.criteria[0]).toMatchObject({ status: 'missing', by: 'mittr', reason: 'test file edited in #3' });
  });

  it('never asks a judge about a criterion its script already failed', async () => {
    const failing = [{ ...criteria[0], check: { type: 'command', command: 'npm test' } }];
    const judge = vi.fn(async () => ({ results: [], decidedBy: [] }));
    const service = modelService([]);
    const evaluate = createCriteriaEvaluator({ getMittrGoalJudge: () => ({ judge }), getSmallModelService: async () => service });

    const result = await evaluate({ objective: 'o', criteria: failing, evidence, directory: '/w' });

    expect(judge).not.toHaveBeenCalled();
    expect(service.generateSmallModelText).not.toHaveBeenCalled();
    expect(result.criteria[0]).toMatchObject({ status: 'missing', by: 'script' });
  });

  it('falls back to the session model when Mittr cannot judge', async () => {
    const judge = vi.fn(async () => { throw Object.assign(new Error('Sign in to Mittr first'), { statusCode: 401 }); });
    const service = modelService([{ id: 'c2', verdict: 'missing', why: 'no README change in the record' }]);
    const evaluate = createCriteriaEvaluator({ getMittrGoalJudge: () => ({ judge }), getSmallModelService: async () => service });

    const result = await evaluate({ objective: 'o', criteria, evidence, directory: '/w' });

    expect(result.criteria[1]).toMatchObject({ status: 'missing', by: 'model', reason: 'no README change in the record' });
    const prompt = service.generateSmallModelText.mock.calls[0][0].prompt;
    expect(prompt).toContain('c2: The README explains setup');
    expect(prompt).toMatch(/c1: Tests pass \(automatic check passed:/);
  });

  it('falls back to a passed script verdict when no judge answers', async () => {
    const evaluate = createCriteriaEvaluator({
      getMittrGoalJudge: () => null,
      getSmallModelService: async () => { throw Object.assign(new Error('none'), { statusCode: 404 }); },
    });

    const result = await evaluate({ objective: 'o', criteria, evidence, directory: '/w' });

    expect(result.criteria[0]).toMatchObject({ status: 'met', by: 'script' });
  });

  it('reports what nobody could judge instead of guessing', async () => {
    const evaluate = createCriteriaEvaluator({
      getMittrGoalJudge: () => null,
      getSmallModelService: async () => { throw Object.assign(new Error('none'), { statusCode: 404 }); },
    });

    const result = await evaluate({ objective: 'o', criteria, evidence, directory: '/w' });

    expect(result.unresolved).toEqual(['c2']);
    expect(result.criteria[1].status).toBe('pending');
  });
});

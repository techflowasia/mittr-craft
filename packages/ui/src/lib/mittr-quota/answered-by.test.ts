import { describe, expect, test } from 'bun:test';

import { answeredByFor, fetchAnsweredBy, parseAnsweredByList, type AnsweredBy } from './answered-by';

const ANSWER: AnsweredBy = {
  at: 1500,
  model: 'mittr-1',
  reason: 'quota',
  requestedLabel: 'MITTR 1.0',
  answeredLabel: 'MittrCraft 1.0',
};

describe('answered by', () => {
  test('keeps readable answers and drops the rest', () => {
    expect(parseAnsweredByList({ now: 2000, answers: [ANSWER, { ...ANSWER, reason: 'other' }, { at: 'x' }] }))
      .toEqual({ now: 2000, answers: [ANSWER] });
    expect(parseAnsweredByList({ answers: [] })).toBeNull();
    expect(parseAnsweredByList(null)).toBeNull();
  });

  test('matches the answer to the message whose request it was', () => {
    const message = { modelID: 'mittr-1', created: 1000, completed: 2000 };
    expect(answeredByFor([ANSWER], message)).toEqual(ANSWER);
    expect(answeredByFor([ANSWER], { ...message, modelID: 'mittr-2' })).toBeNull();
    expect(answeredByFor([ANSWER], { ...message, created: 1600 })).toBeNull();
    expect(answeredByFor([ANSWER], { ...message, completed: 1400 })).toBeNull();
    const later = { ...ANSWER, at: 1800, reason: 'failed' as const };
    expect(answeredByFor([ANSWER, later], message)).toEqual(later);
  });

  test('asks for the session and treats a failed read as failure, not as nothing substituted', async () => {
    const urls: string[] = [];
    const ok = await fetchAnsweredBy(async (input) => {
      urls.push(input);
      return new Response(JSON.stringify({ now: 1, answers: [] }), { status: 200 });
    }, 'ses 1');
    expect(ok).toEqual({ now: 1, answers: [] });
    expect(urls).toEqual(['/api/mittr/answered-by?sessionId=ses%201']);

    await expect(fetchAnsweredBy(async () => new Response('{}', { status: 404 }), 'ses_1')).rejects.toThrow();
    await expect(fetchAnsweredBy(async () => new Response('nope', { status: 200 }), 'ses_1')).rejects.toThrow();
  });
});

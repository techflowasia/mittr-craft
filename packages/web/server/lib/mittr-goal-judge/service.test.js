import { describe, expect, it, vi } from 'vitest';

import { createMittrGoalJudge } from './service.js';

const session = { accessToken: 'token-1' };
const request = {
  objective: 'เขียนรายงาน',
  criteria: [{ id: 'c1', text: 'มีรายงาน' }, { id: 'c2', text: 'อ้างอิงแหล่งที่มา' }],
  evidence: '#1 write completed',
  report: 'done',
};

const judgeWith = (response, { ensureFreshSession = async () => session } = {}) => {
  const fetchImpl = vi.fn(async () => response);
  const judge = createMittrGoalJudge({ brokerBaseUrl: 'https://api.example/', ensureFreshSession, fetchImpl });
  return { judge, fetchImpl };
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

describe('createMittrGoalJudge', () => {
  it('is absent when this install cannot reach the platform', () => {
    expect(createMittrGoalJudge({})).toBeNull();
  });

  it('posts the criteria and the tool record with the desktop session', async () => {
    const { judge, fetchImpl } = judgeWith(json({
      results: [{ id: 'c1', verdict: 'met', why: 'written' }, { id: 'c2', verdict: 'missing', why: 'no source' }],
      decidedBy: ['typesafe/jev-1.13', 'typesafe/jev-1.13'],
      ms: 420,
    }));
    const reply = await judge.judge(request);
    expect(reply).toEqual({
      results: [{ id: 'c1', verdict: 'met', why: 'written' }, { id: 'c2', verdict: 'missing', why: 'no source' }],
      decidedBy: ['typesafe/jev-1.13'],
      ms: 420,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example/desktop/goal/judge');
    expect(init.headers.Authorization).toBe('Bearer token-1');
    expect(JSON.parse(init.body)).toEqual(request);
  });

  it('drops verdicts outside the fixed set and criteria that were not asked', async () => {
    const { judge } = judgeWith(json({
      results: [{ id: 'c1', verdict: 'probably', why: '' }, { id: 'c9', verdict: 'met', why: '' }, { id: 'c2', verdict: 'needs_person', why: 'login' }],
    }));
    expect((await judge.judge(request)).results).toEqual([{ id: 'c2', verdict: 'needs_person', why: 'login' }]);
  });

  it('refuses a reply without results', async () => {
    await expect(judgeWith(json({})).judge.judge(request)).rejects.toMatchObject({ statusCode: 502 });
  });

  it('asks the person to sign in when there is no session', async () => {
    const { judge } = judgeWith(json({}), { ensureFreshSession: async () => null });
    await expect(judge.judge(request)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('passes the platform’s own error through', async () => {
    const { judge } = judgeWith(json({ message: 'desktop_session_required' }, 403));
    await expect(judge.judge(request)).rejects.toMatchObject({ statusCode: 403, message: 'desktop_session_required' });
  });
});

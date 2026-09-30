import { describe, expect, test } from 'bun:test';

import { fetchQuotaMe, parseQuotaMe, usedPercent } from './quota-me';

const QUOTA = {
  weekStart: '2026-09-27T17:00:00.000Z',
  resetsAt: '2026-10-04T17:00:00.000Z',
  lines: [
    { modelKey: 'mittr-2', kind: 'chat', label: 'MITTR 2.0', used: 250000, limit: 500000, source: 'group' },
    { modelKey: 'asr', kind: 'stt', label: 'Voice', used: 700, limit: 600, source: 'default' },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('parseQuotaMe', () => {
  test('keeps the week and every readable line', () => {
    const parsed = parseQuotaMe({ ...QUOTA, lines: [...QUOTA.lines, { kind: 'video' }] });
    expect(parsed?.resetsAt).toBe(QUOTA.resetsAt);
    expect(parsed?.lines.map((line) => line.modelKey)).toEqual(['mittr-2', 'asr']);
  });

  test('refuses a body that is not a week', () => {
    expect(parseQuotaMe({ lines: [] })).toBeNull();
    expect(parseQuotaMe(null)).toBeNull();
  });
});

describe('fetchQuotaMe', () => {
  test('reads the local quota route', async () => {
    const calls: string[] = [];
    const result = await fetchQuotaMe(async (input) => {
      calls.push(input);
      return json(QUOTA);
    });
    expect(calls).toEqual(['/api/mittr/quota/me']);
    expect(result.status).toBe('ok');
  });

  test('tells a signed-out person apart from an offline platform and a broken answer', async () => {
    expect(await fetchQuotaMe(async () => json({ reasonCode: 'not_signed_in' }, 401))).toEqual({ status: 'not_signed_in' });
    expect(await fetchQuotaMe(async () => json({ reasonCode: 'unreachable' }, 502))).toEqual({ status: 'unreachable' });
    expect(await fetchQuotaMe(async () => { throw new TypeError('Failed to fetch'); })).toEqual({ status: 'unreachable' });
    expect(await fetchQuotaMe(async () => json({ reasonCode: 'upstream_failed' }, 502))).toEqual({ status: 'failed' });
    expect(await fetchQuotaMe(async () => json({ nope: true }))).toEqual({ status: 'failed' });
    expect(await fetchQuotaMe(async () => json({ reasonCode: 'not_available' }, 404))).toEqual({ status: 'not_available' });
    expect(await fetchQuotaMe(async () => json({ reasonCode: 'not_configured' }, 503))).toEqual({ status: 'not_available' });
    expect(await fetchQuotaMe(async () => new Response('', { status: 503 }))).toEqual({ status: 'unreachable' });
  });
});

describe('usedPercent', () => {
  test('caps at a full bar', () => {
    expect(usedPercent({ modelKey: 'a', kind: 'chat', label: 'A', used: 250000, limit: 500000 })).toBe(50);
    expect(usedPercent({ modelKey: 'b', kind: 'stt', label: 'B', used: 700, limit: 600 })).toBe(100);
  });
});

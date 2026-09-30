import { describe, expect, test } from 'bun:test';

import type { QuotaMeResult } from './quota-me';
import { QUOTA_ME_FRESH_MS, createQuotaMeStore } from './quota-me-store';

const OK: QuotaMeResult = {
  status: 'ok',
  quota: { weekStart: '2026-09-27T17:00:00.000Z', resetsAt: '2026-10-04T17:00:00.000Z', lines: [] },
};

describe('quota me store', () => {
  test('asks once for callers that open together and reuses the answer for a short while', async () => {
    let calls = 0;
    const store = createQuotaMeStore(async () => {
      calls += 1;
      return OK;
    });
    await Promise.all([store.getState().load(), store.getState().load()]);
    expect(calls).toBe(1);
    expect(store.getState().state).toEqual(OK);

    await store.getState().load({ now: Date.now() + 1_000 });
    expect(calls).toBe(1);
    await store.getState().load({ now: Date.now() + QUOTA_ME_FRESH_MS + 1_000 });
    expect(calls).toBe(2);
    await store.getState().load({ force: true });
    expect(calls).toBe(3);
  });

  test('records a failed read as failed, not as an empty week', async () => {
    const store = createQuotaMeStore(async () => {
      throw new Error('boom');
    });
    await store.getState().load();
    expect(store.getState().state).toEqual({ status: 'failed' });
  });
});

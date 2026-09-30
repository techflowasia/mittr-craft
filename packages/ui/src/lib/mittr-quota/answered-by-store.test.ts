import { describe, expect, test } from 'bun:test';

import type { AnsweredByList } from './answered-by';
import { createAnsweredByStore } from './answered-by-store';

const LIST: AnsweredByList = {
  now: 5000,
  answers: [{ at: 4000, model: 'mittr-1', reason: 'quota', requestedLabel: 'MITTR 1.0', answeredLabel: 'MittrCraft 1.0' }],
};

describe('answered by store', () => {
  test('asks once per session for messages that finish together and not again for older ones', async () => {
    let calls = 0;
    const store = createAnsweredByStore(async () => {
      calls += 1;
      return LIST;
    });
    await Promise.all([store.getState().load('ses_1', 4500), store.getState().load('ses_1', 4800)]);
    expect(calls).toBe(1);
    expect(store.getState().sessions.ses_1).toEqual(LIST);

    await store.getState().load('ses_1', 3000);
    expect(calls).toBe(1);
    await store.getState().load('ses_1', 6000);
    expect(calls).toBe(2);
    await store.getState().load('ses_2', 1000);
    expect(calls).toBe(3);
  });

  test('a failed read keeps what was known instead of clearing it', async () => {
    let fail = false;
    const store = createAnsweredByStore(async () => {
      if (fail) throw new Error('boom');
      return LIST;
    });
    await store.getState().load('ses_1', 4500);
    fail = true;
    await store.getState().load('ses_1', 9000);
    expect(store.getState().sessions.ses_1).toEqual(LIST);
  });
});

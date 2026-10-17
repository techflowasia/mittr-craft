import { describe, expect, test } from 'bun:test';

import type { JsonValue } from '@openchamber/sdk';

import {
  createQuotaMeController,
  parseQuotaMe,
  QUOTA_ME_ENDPOINT,
  QUOTA_ME_FRESH_MS,
  type QuotaMeFetch,
} from './quotaMeStore';

const agent = (over: Record<string, JsonValue> = {}): JsonValue => ({
  modelKey: 'writer-model',
  left: 0,
  limit: 50,
  resetsAt: '2026-10-20T00:00:00+07:00',
  state: 'out',
  ...over,
});

const week = {
  weekStart: '2026-10-13T00:00:00+07:00',
  resetsAt: '2026-10-20T00:00:00+07:00',
  lines: [],
};

const body = (agentStatus?: JsonValue): JsonValue => (agentStatus === undefined ? week : { ...week, agentStatus });

const ok = (json: JsonValue) => () => Promise.resolve({ ok: true, json: async () => json });
const failing = (status: number) => () => Promise.resolve({ ok: false, json: async (): Promise<JsonValue> => ({ reasonCode: `r${status}` }) });
const offline = () => Promise.reject(new Error('offline'));

const clock = (start = 1_000_000) => {
  let at = start;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
};

const harness = (answers: Array<() => ReturnType<QuotaMeFetch>>) => {
  const paths: string[] = [];
  const queue = [...answers];
  const fetch: QuotaMeFetch = (path) => {
    paths.push(path);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return (next ?? offline)();
  };
  const time = clock();
  const controller = createQuotaMeController({ fetch, now: time.now });
  return { controller, paths, time };
};

describe('parsing this week quota', () => {
  test('agent statuses are kept by alias', () => {
    const quota = parseQuotaMe(body({ writer: agent(), analyst: agent({ state: 'near', left: 5, percentLeft: 10 }) }));
    expect([...(quota?.agentStatus.keys() ?? [])]).toEqual(['writer', 'analyst']);
    expect(quota?.agentStatus.get('analyst')).toEqual({
      modelKey: 'writer-model',
      left: 5,
      limit: 50,
      resetsAt: '2026-10-20T00:00:00+07:00',
      state: 'near',
      percentLeft: 10,
    });
  });

  test('one damaged agent entry is dropped and the others stay', () => {
    const quota = parseQuotaMe(body({ writer: agent(), broken: agent({ state: 'gone' }), worse: 'x', also: agent({ left: -1 }) }));
    expect([...(quota?.agentStatus.keys() ?? [])]).toEqual(['writer']);
  });

  test('an entry keeps no damaged optional field', () => {
    const quota = parseQuotaMe(body({ writer: agent({ state: 'substitute', percentLeft: 'many', substituteLabel: 7 }) }));
    expect(quota?.agentStatus.get('writer')?.percentLeft).toBeUndefined();
    expect(quota?.agentStatus.get('writer')?.substituteLabel).toBeUndefined();
  });

  test('a week with no agent statuses is still a quota', () => {
    expect(parseQuotaMe(body())?.agentStatus.size).toBe(0);
  });

  test('something that is not a quota body is refused', () => {
    expect(parseQuotaMe(null)).toBeNull();
    expect(parseQuotaMe([])).toBeNull();
    expect(parseQuotaMe({ agentStatus: { writer: agent() } })).toBeNull();
    expect(parseQuotaMe({ weekStart: 'x', resetsAt: 'x', lines: [] })).toBeNull();
  });
});

describe('quota controller', () => {
  test('it reads the quota route and keeps the agent statuses', async () => {
    const { controller, paths } = harness([ok(body({ writer: agent() }))]);
    expect(controller.snapshot()).toEqual({ status: 'idle' });
    await controller.load();
    expect(paths).toEqual([QUOTA_ME_ENDPOINT]);
    const state = controller.snapshot();
    expect(state.status).toBe('ok');
    if (state.status === 'ok') expect(state.quota.agentStatus.get('writer')?.state).toBe('out');
  });

  test('a read is fresh for 30 seconds and read again after', async () => {
    const { controller, paths, time } = harness([ok(body({ writer: agent() }))]);
    await controller.load();
    time.advance(QUOTA_ME_FRESH_MS - 1);
    await controller.load();
    expect(paths).toHaveLength(1);
    time.advance(1);
    await controller.load();
    expect(paths).toHaveLength(2);
  });

  test('force reads again while fresh', async () => {
    const { controller, paths } = harness([ok(body())]);
    await controller.load();
    await controller.load({ force: true });
    expect(paths).toHaveLength(2);
  });

  test('two opens at once share one read', async () => {
    const { controller, paths } = harness([ok(body())]);
    await Promise.all([controller.load(), controller.load()]);
    expect(paths).toHaveLength(1);
  });

  test('a failed read marks nothing and stays fresh for 30 seconds like a good one', async () => {
    const { controller, paths, time } = harness([failing(503), ok(body({ writer: agent() }))]);
    await controller.load();
    expect(controller.snapshot()).toEqual({ status: 'unavailable' });
    time.advance(QUOTA_ME_FRESH_MS - 1);
    await controller.load();
    expect(paths).toHaveLength(1);
    time.advance(1);
    await controller.load();
    expect(paths).toHaveLength(2);
    expect(controller.snapshot().status).toBe('ok');
  });

  test('two opens at once share one failing read too', async () => {
    const { controller, paths } = harness([offline]);
    await Promise.all([controller.load(), controller.load()]);
    expect(paths).toHaveLength(1);
    expect(controller.snapshot()).toEqual({ status: 'unavailable' });
  });

  test('a read that fails after a good one clears the marks', async () => {
    const { controller, time } = harness([ok(body({ writer: agent() })), offline]);
    await controller.load();
    expect(controller.snapshot().status).toBe('ok');
    time.advance(QUOTA_ME_FRESH_MS);
    await controller.load();
    expect(controller.snapshot()).toEqual({ status: 'unavailable' });
  });

  test('an answer that is not a quota body reads as unavailable', async () => {
    const { controller } = harness([ok({ hello: 'world' })]);
    await controller.load();
    expect(controller.snapshot()).toEqual({ status: 'unavailable' });
  });

  test('listeners hear each change and can stop listening', async () => {
    const { controller } = harness([ok(body())]);
    let heard = 0;
    const stop = controller.subscribe(() => { heard += 1; });
    await controller.load();
    expect(heard).toBe(1);
    stop();
    await controller.load({ force: true });
    expect(heard).toBe(1);
  });
});

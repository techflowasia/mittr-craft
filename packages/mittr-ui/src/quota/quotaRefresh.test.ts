import { describe, expect, test } from 'bun:test';
import { createQuotaMeController, parseQuotaMe, type QuotaMeResponse } from './quotaMeStore';

const week = { weekStart: '2026-10-20T00:00:00Z', resetsAt: '2026-10-27T00:00:00Z', lines: [] };

describe('alias quota refresh boundaries', () => {
  test('JSON own prototype-named explicit statuses override membership', () => {
    for (const state of ['substitute', 'out']) {
      const payload = JSON.parse(`{"weekStart":"2026-10-20T00:00:00Z","resetsAt":"2026-10-27T00:00:00Z","lines":[{"modelKey":"bucket","kind":"chat","used":0,"limit":100,"agents":[{"key":"__proto__"},{"key":"constructor"}]}],"agentStatus":{"__proto__":{"modelKey":"explicit","left":0,"limit":100,"resetsAt":"2026-10-27T00:00:00Z","state":"${state}"},"constructor":{"modelKey":"explicit","left":0,"limit":100,"resetsAt":"2026-10-27T00:00:00Z","state":"${state}"}}}`);
      const quota = parseQuotaMe(payload);
      expect(quota?.agentStatus.get('__proto__')?.state).toBe(state);
      expect(quota?.agentStatus.get('constructor')?.state).toBe(state);
    }
  });
  test('shared bucket membership fills arbitrary aliases but explicit substitute wins', () => {
    const quota = parseQuotaMe({ ...week, lines: [{ modelKey: 'internal', kind: 'chat', used: 100, limit: 100, agents: [{ key: 'new-alias' }, { key: 'sub' }] }], agentStatus: { sub: { modelKey: 'backup', left: 20, limit: 100, resetsAt: week.resetsAt, state: 'substitute' } } });
    expect(quota?.agentStatus.get('new-alias')?.state).toBe('out');
    expect(quota?.agentStatus.get('sub')?.state).toBe('substitute');
    expect(quota?.agentStatus.get('internal')?.limit).toBe(100);
  });

  test('runtime changes isolate cached quota and reject old-runtime completion', async () => {
    let runtime = 'one';
    let changed = () => {};
    let release = (response: QuotaMeResponse) => { void response; };
    const controller = createQuotaMeController({
      runtime: () => runtime,
      watchRuntime: (listener) => { changed = listener; return () => { changed = () => {}; }; },
      fetch: () => new Promise(resolve => { release = resolve; }),
    });
    const stop = controller.subscribe(() => {});
    const old = controller.load();
    runtime = 'two'; changed();
    release({ ok: true, json: async () => week });
    await old;
    expect(controller.snapshot()).toEqual({ status: 'idle' });
    stop();
  });

  test('A to B to A aborts and rejects an old A completion without joining it', async () => {
    let account = 'A';
    const watches = new Set<() => void>();
    const pending: Array<{ signal?: AbortSignal; resolve: (response: QuotaMeResponse) => void }> = [];
    const controller = createQuotaMeController({
      account: () => account,
      watchAccount: (fn) => { watches.add(fn); return () => { watches.delete(fn); }; },
      fetch: (_path, options) => new Promise((resolve) => pending.push({ signal: options?.signal, resolve })),
    });
    const stop = controller.subscribe(() => {});
    const old = controller.load();
    account = 'B'; for (const fn of watches) fn();
    account = 'A'; for (const fn of watches) fn();
    const current = controller.load();
    expect(pending).toHaveLength(2);
    expect(pending[0].signal?.aborted).toBe(true);
    pending[0].resolve({ ok: true, json: async () => week });
    await old;
    expect(controller.snapshot()).toEqual({ status: 'idle' });
    pending[1].resolve({ ok: true, json: async () => week });
    await current;
    expect(controller.snapshot().status).toBe('ok');
    stop();
    expect(watches.size).toBe(0);
  });
});

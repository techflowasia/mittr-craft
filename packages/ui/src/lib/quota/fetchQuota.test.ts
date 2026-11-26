import { afterEach, expect, mock, test } from 'bun:test';

let responsePayload: unknown;
let responseText: string | null = null;
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async () => (responseText === null ? Response.json(responsePayload) : new Response(responseText, { status: 200 })),
}));
const { fetchQuota } = await import('./fetchQuota');

afterEach(() => {
  responseText = null;
  mock.restore();
});

test('quota transport preserves structured Zen values for windows and models', async () => {
  const window = {
    usedPercent: null, remainingPercent: null, windowSeconds: null, resetAfterSeconds: null,
    resetAt: null, resetAtFormatted: null, resetAfterFormatted: null,
  };
  responsePayload = {
    providerId: 'opencode', providerName: 'OpenCode Zen', ok: true, configured: true, fetchedAt: 1,
    usage: {
      windows: {
        daily: { ...window, value: { kind: 'requests', count: 0 } },
        monthly: { ...window, value: { kind: 'spend', spent: 2, limit: 10 } },
      },
      models: { test: { windows: { monthly: { ...window, value: { kind: 'requests', count: 42 } } } } },
    },
  };
  const result = await fetchQuota('opencode');
  expect(result.usage?.windows.daily?.value).toEqual({ kind: 'requests', count: 0 });
  expect(result.usage?.windows.monthly?.value).toEqual({ kind: 'spend', spent: 2, limit: 10 });
  expect(result.usage?.models?.test?.windows.monthly?.value).toEqual({ kind: 'requests', count: 42 });
});

test('preserves semantic credits-used data through the quota response parser', async () => {
  const window = {
    usedPercent: null,
    remainingPercent: null,
    windowSeconds: null,
    resetAfterSeconds: null,
    resetAt: null,
    resetAtFormatted: null,
    resetAfterFormatted: null,
    creditsUsed: 0,
  };
  responsePayload = {
    providerId: 'github-copilot',
    providerName: 'GitHub Copilot',
    ok: true,
    configured: true,
    planLabel: 'Copilot Business',
    accountLabel: 'other@example.com',
    usage: { windows: { premium_interactions: window } },
    fetchedAt: 1,
  };

  const result = await fetchQuota('github-copilot');
  expect(result.usage?.windows.premium_interactions).toEqual(window);
  expect(result.planLabel).toBe('Copilot Business');
  expect(result.accountLabel).toBe('other@example.com');
});

test('malformed prototype-named meter values are rejected rather than dropped', async () => {
  responseText = '{"providerId":"codex","providerName":"Codex","ok":true,"configured":true,"usage":{"windows":{},"models":{"__proto__":{"windows":{"week":{"usedPercent":"bad"}}}}},"fetchedAt":1}';
  await expect(fetchQuota('codex')).rejects.toThrow();
});

test('JSON own prototype-named model and window meters survive strict parsing', async () => {
  const window = { usedPercent: 80, remainingPercent: 20, windowSeconds: null, resetAfterSeconds: null, resetAt: null, resetAtFormatted: null, resetAfterFormatted: null };
  const meters = Object.fromEntries([['__proto__', { windows: Object.fromEntries([['__proto__', window]]) }], ['constructor', { windows: { week: window } }]]);
  responseText = JSON.stringify({ providerId: 'codex', providerName: 'Codex', ok: true, configured: true, usage: { windows: {}, models: meters }, fetchedAt: 1 });
  const result = await fetchQuota('codex');
  expect(Object.keys(result.usage?.models ?? {})).toEqual(['__proto__', 'constructor']);
  expect(result.usage?.models?.['__proto__'].windows['__proto__'].usedPercent).toBe(80);
  expect(result.usage?.models?.['constructor'].windows.week.remainingPercent).toBe(20);
});

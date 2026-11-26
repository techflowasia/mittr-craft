import { expect, test } from 'bun:test';
import { registerQuotaProviderRefreshHook, refreshQuotaProvider } from './index';

test('refresh extensions settle independently and unregister without removing a replacement', async () => {
  const calls: string[] = [];
  const stopOld = registerQuotaProviderRefreshHook('codex', async () => { throw new Error('offline'); });
  const stop = registerQuotaProviderRefreshHook('codex', async ({ signal }) => { if (!signal.aborted) calls.push('fresh'); });
  stopOld();
  await refreshQuotaProvider('codex', { signal: new AbortController().signal });
  expect(calls).toEqual(['fresh']);
  stop();
  await refreshQuotaProvider('codex', { signal: new AbortController().signal });
  expect(calls).toEqual(['fresh']);
});

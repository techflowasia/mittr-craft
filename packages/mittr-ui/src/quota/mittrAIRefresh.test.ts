import { expect, test } from 'bun:test';
import { createMittrAIRefresh } from './mittrAIRefresh';

test('catalog discovery uses the server freshness gate and shares concurrent opens', async () => {
  const requests: Array<{ path: string; body?: string }> = [];
  const refresh = createMittrAIRefresh({
    fetch: async (path, options) => { requests.push({ path, body: options.body }); return { ok: true }; },
    quota: async () => {},
  });
  await Promise.all([refresh.catalog(), refresh.catalog()]);
  expect(requests).toEqual([{ path: '/api/mittr/catalog/sync', body: '{"force":false}' }]);
  refresh.dispose();
});

test('usage refresh forces alias quota even if catalog fails; dispose aborts requests', async () => {
  let forced = false;
  let signal: AbortSignal | undefined;
  const refresh = createMittrAIRefresh({
    fetch: async (_path, options) => { signal = options.signal; throw new Error('offline'); },
    quota: async (options) => { forced = options.force === true; },
  });
  await refresh.refresh();
  expect(forced).toBe(true);
  refresh.dispose();
  expect(signal?.aborted).toBe(true);
});

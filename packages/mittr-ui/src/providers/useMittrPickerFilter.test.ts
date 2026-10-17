import { describe, expect, test } from 'bun:test';

import type { JsonValue } from '@openchamber/sdk';

import {
  createProviderLockController,
  mittrPickerDecorations,
  PROVIDER_LOCK_ENDPOINT,
  type LockFetch,
  type LockResponse,
} from './useMittrPickerFilter';

type Call = { path: string; method: string; body?: string };
type Answer = (call: Call) => Promise<LockResponse>;

const answer = (body: JsonValue, status = 200): Answer => () => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
const unreachable: Answer = () => Promise.reject(new Error('offline'));

const fakeFetch = (answers: { get?: Answer[]; put?: Answer[] }) => {
  const calls: Call[] = [];
  const fetch: LockFetch = (path, init) => {
    const call = { path, method: init?.method ?? 'GET', body: init?.body };
    calls.push(call);
    const queue = (call.method === 'PUT' ? answers.put : answers.get) ?? [];
    const next = (queue.length > 1 ? queue.shift() : queue[0]) ?? unreachable;
    return next(call);
  };
  return { fetch, calls, gets: () => calls.filter((call) => call.method === 'GET').length };
};

const fakeChannel = () => {
  const handlers = new Set<() => void>();
  let announced = 0;
  return {
    subscribe: (handler: () => void) => {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    announce: () => { announced += 1; },
    fire: () => { for (const handler of handlers) handler(); },
    announced: () => announced,
    listening: () => handlers.size,
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('provider lock controller', () => {
  test('the picker filter re-reads on the change event', async () => {
    const http = fakeFetch({ get: [answer({ showOtherProviders: false }), answer({ showOtherProviders: true })] });
    const channel = fakeChannel();
    const controller = createProviderLockController({ fetch: http.fetch, subscribe: channel.subscribe, announce: channel.announce, reloadProviders: () => {} });
    expect(http.gets()).toBe(0);

    await controller.refresh();
    expect(http.calls).toEqual([{ path: PROVIDER_LOCK_ENDPOINT, method: 'GET', body: undefined }]);
    expect(controller.snapshot()).toEqual({ showOtherProviders: false, known: true });

    channel.fire();
    await settle();
    expect(http.gets()).toBe(2);
    expect(controller.snapshot()).toEqual({ showOtherProviders: true, known: true });

    controller.dispose();
    expect(channel.listening()).toBe(0);
  });

  test('before any answer, and when the read fails, other providers stay hidden', async () => {
    const http = fakeFetch({ get: [unreachable] });
    const channel = fakeChannel();
    const controller = createProviderLockController({ fetch: http.fetch, subscribe: channel.subscribe, announce: channel.announce, reloadProviders: () => {} });
    expect(controller.snapshot()).toEqual({ showOtherProviders: false, known: false });
    await controller.refresh();
    expect(controller.snapshot()).toEqual({ showOtherProviders: false, known: false });
  });

  test('an answer that is not a plain true or false is ignored', async () => {
    const bodies: JsonValue[] = [{ showOtherProviders: 'true' }, {}, null, [true]];
    for (const body of bodies) {
      const http = fakeFetch({ get: [answer(body)] });
      const controller = createProviderLockController({ fetch: http.fetch, subscribe: fakeChannel().subscribe, announce: () => {}, reloadProviders: () => {} });
      await controller.refresh();
      expect(controller.snapshot()).toEqual({ showOtherProviders: false, known: false });
    }
    const refused = fakeFetch({ get: [answer({ showOtherProviders: true }, 500)] });
    const controller = createProviderLockController({ fetch: refused.fetch, subscribe: fakeChannel().subscribe, announce: () => {}, reloadProviders: () => {} });
    await controller.refresh();
    expect(controller.snapshot().showOtherProviders).toBe(false);
  });

  test('an older read that answers late does not overwrite a newer one', async () => {
    let releaseFirst: () => void = () => {};
    const first: Answer = () => new Promise((resolve) => {
      releaseFirst = () => resolve({ ok: true, status: 200, json: async () => ({ showOtherProviders: true }) });
    });
    const http = fakeFetch({ get: [first, answer({ showOtherProviders: false })] });
    const controller = createProviderLockController({ fetch: http.fetch, subscribe: fakeChannel().subscribe, announce: () => {}, reloadProviders: () => {} });
    const older = controller.refresh();
    await controller.refresh();
    releaseFirst();
    await older;
    expect(controller.snapshot()).toEqual({ showOtherProviders: false, known: true });
  });

  test('saving puts the value, shows what the server stored and tells other windows', async () => {
    const http = fakeFetch({ put: [answer({ showOtherProviders: true })] });
    const channel = fakeChannel();
    const controller = createProviderLockController({ fetch: http.fetch, subscribe: channel.subscribe, announce: channel.announce, reloadProviders: () => {} });
    const seen: boolean[] = [];
    controller.subscribe(() => seen.push(controller.snapshot().showOtherProviders));

    expect(await controller.save(true)).toBe('saved');

    expect(http.calls).toEqual([{ path: PROVIDER_LOCK_ENDPOINT, method: 'PUT', body: JSON.stringify({ showOtherProviders: true }) }]);
    expect(controller.snapshot()).toEqual({ showOtherProviders: true, known: true });
    expect(seen.at(-1)).toBe(true);
    expect(channel.announced()).toBe(1);
  });

  test('a save the engine has not taken up yet still shows the stored value', async () => {
    const http = fakeFetch({ put: [answer({ error: 'not yet', showOtherProviders: true }, 500)] });
    const channel = fakeChannel();
    const controller = createProviderLockController({ fetch: http.fetch, subscribe: channel.subscribe, announce: channel.announce, reloadProviders: () => {} });
    expect(await controller.save(true)).toBe('not-applied');
    expect(controller.snapshot()).toEqual({ showOtherProviders: true, known: true });
    expect(channel.announced()).toBe(1);
  });

  test('a save that failed re-reads, so the switch shows what is really stored', async () => {
    const http = fakeFetch({ put: [answer({ error: 'Cannot store' }, 500)], get: [answer({ showOtherProviders: false })] });
    const channel = fakeChannel();
    const controller = createProviderLockController({ fetch: http.fetch, subscribe: channel.subscribe, announce: channel.announce, reloadProviders: () => {} });
    expect(await controller.save(true)).toBe('failed');
    expect(http.gets()).toBe(1);
    expect(controller.snapshot()).toEqual({ showOtherProviders: false, known: true });
    expect(channel.announced()).toBe(0);

    const offline = fakeFetch({});
    const second = createProviderLockController({ fetch: offline.fetch, subscribe: channel.subscribe, announce: channel.announce, reloadProviders: () => {} });
    expect(await second.save(false)).toBe('failed');
  });
});

describe('the provider list after the switch changes', () => {
  test('a stored save and a change from another window ask for a fresh provider list; a failed save does not', async () => {
    const http = fakeFetch({
      put: [answer({ showOtherProviders: true }), answer({ error: 'not yet', showOtherProviders: false }, 500), answer({ error: 'Cannot store' }, 500)],
      get: [answer({ showOtherProviders: false })],
    });
    const channel = fakeChannel();
    let reloads = 0;
    const controller = createProviderLockController({ fetch: http.fetch, subscribe: channel.subscribe, announce: channel.announce, reloadProviders: () => { reloads += 1; } });

    expect(await controller.save(true)).toBe('saved');
    expect(reloads).toBe(1);
    expect(await controller.save(false)).toBe('not-applied');
    expect(reloads).toBe(2);
    expect(await controller.save(true)).toBe('failed');
    expect(reloads).toBe(2);

    channel.fire();
    await settle();
    expect(reloads).toBe(3);
  });
});

describe('Mittr picker decorations', () => {
  test('with the switch off only Mittr is shown; on, every provider is', () => {
    const off = mittrPickerDecorations({ showOtherProviders: false });
    expect(off.isProviderShown('mittr')).toBe(true);
    expect(off.isProviderShown('openai')).toBe(false);
    expect(off.isProviderShown('opencode')).toBe(false);
    expect(off.entryStatus({ providerID: 'mittr', modelID: 'a1', name: 'Writer' })).toBeNull();

    const on = mittrPickerDecorations({ showOtherProviders: true });
    expect(on.isProviderShown('mittr')).toBe(true);
    expect(on.isProviderShown('openai')).toBe(true);
  });

  test('the picker offers to add a provider only while other providers are shown', () => {
    expect(mittrPickerDecorations({ showOtherProviders: false }).offersAddProvider).toBe(false);
    expect(mittrPickerDecorations({ showOtherProviders: true }).offersAddProvider).toBe(true);
  });
});

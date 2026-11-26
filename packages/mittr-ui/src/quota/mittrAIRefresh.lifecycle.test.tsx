import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from '../../../ui/node_modules/happy-dom';

const browser = new Window({ url: 'http://localhost/' });
const originals = new Map<string, PropertyDescriptor | undefined>();
const requests: string[] = [];
let used = 100;
let holdQuota = false;
const held: Array<{ signal?: AbortSignal | null; resolve: (response: Response) => void }> = [];
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  fetch: async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input instanceof Request ? input.url : input);
    requests.push(path);
    if (!path.includes('/api/mittr/') && !path.includes('/api/quota/')) return new Promise<Response>(() => {});
    if (holdQuota && path.includes('/api/mittr/quota/me')) return new Promise<Response>(resolve => held.push({ signal: init?.signal, resolve }));
    if (path.includes('/api/mittr/quota/me')) return Response.json({ weekStart: '2026-10-20T00:00:00Z', resetsAt: '2026-10-27T00:00:00Z', lines: [{ modelKey: 'bucket', kind: 'chat', used, limit: 100, agents: [{ key: 'new-alias' }] }] });
    if (path.includes('/api/quota/')) return Response.json({ providerId: 'codex', providerName: 'Codex', ok: true, configured: true, usage: null, fetchedAt: 1 });
    return Response.json({ showOtherProviders: false });
  },
})) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
afterAll(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
const { createRoot } = await import('react-dom/client');
const { MittrAIRefresh } = await import('./mittrAIRefresh');
const { useQuotaMe } = await import('./quotaMeStore');
const { useMittrPickerDecorations } = await import('../providers/useMittrPickerFilter');
const { useQuotaStore, useQuotaAutoRefresh } = await import('../../../ui/src/stores/useQuotaStore');
const { MITTR_PROVIDER_ID } = await import('../mittrProvider');
const { registerQuotaProvider, QUOTA_PROVIDERS } = await import('../../../ui/src/lib/quota/providers');
const { useConfigStore } = await import('../../../ui/src/stores/useConfigStore');
const { initializeRuntimeEndpoint } = await import('../../../ui/src/lib/runtime-switch');
registerQuotaProvider({ id: MITTR_PROVIDER_ID, name: 'Mittr AI' });

function Picker({ open }: { open: boolean }) {
  useMittrPickerDecorations(open);
  const quota = useQuotaMe(open);
  return <span>{quota.status === 'ok' ? quota.quota.agentStatus.get('new-alias')?.state : quota.status}</span>;
}
function Cadence({ enabled }: { enabled: boolean }) { useQuotaAutoRefresh(enabled); return null; }

const { setSignedInAccount } = await import('../sign-in/signedInAccount');
const { sharedQuotaMeController } = await import('./quotaMeStore');

test('mounted owner changes and pending unmount reject late quota responses', async () => {
  holdQuota = true;
  held.length = 0;
  setSignedInAccount('mounted-A');
  const node = document.createElement('div');
  const root = createRoot(node);
  const response = (used: number) => Response.json({ weekStart: '2026-10-20T00:00:00Z', resetsAt: '2026-10-27T00:00:00Z', lines: [{ modelKey: 'bucket', kind: 'chat', used, limit: 100, agents: [{ key: 'new-alias' }] }] });
  try {
    await act(async () => { root.render(<><MittrAIRefresh /><Picker open /></>); });
    expect(held).toHaveLength(1);
    await act(async () => { setSignedInAccount('mounted-B'); });
    expect(held[0].signal?.aborted).toBe(true);
    expect(held).toHaveLength(2);
    await act(async () => { held[0].resolve(response(100)); });
    expect(node.textContent).toBe('idle');
    await act(async () => { held[1].resolve(response(0)); });
    expect(node.textContent).toBe('ok');
    await act(async () => { void sharedQuotaMeController().load({ force: true }); });
    expect(held).toHaveLength(3);
    await act(async () => { root.unmount(); });
    expect(held[2].signal?.aborted).toBe(true);
    held[2].resolve(response(100));
    await Promise.resolve();
    expect(sharedQuotaMeController().snapshot().status).toBe('ok');
  } finally { await act(async () => { root.unmount(); }); holdQuota = false; setSignedInAccount(null); }
});

test('open picker discovers catalog, manual Usage refresh replaces mounted alias quota; cleanup stops refresh ownership', async () => {
  const node = document.createElement('div');
  const root = createRoot(node);
  await act(async () => { root.render(<><MittrAIRefresh /><Picker open={false} /></>); });
  requests.length = 0;
  await act(async () => { root.render(<><MittrAIRefresh /><Picker open /></>); });
  expect(requests.some(path => path.includes('/api/mittr/catalog/sync'))).toBe(true);
  expect(node.textContent).toBe('out');
  used = 10;
  await act(async () => { await useQuotaStore.getState().fetchAllQuotas(); });
  expect(node.textContent).toBe('ok');
  expect(requests.filter(path => path.includes('/api/mittr/quota/me')).length).toBeGreaterThan(0);
  await act(async () => { root.unmount(); });
  requests.length = 0;
  browser.dispatchEvent(new browser.Event('focus'));
  await Promise.resolve();
  expect(requests).toEqual([]);
});

test('open consumers share one existing three-minute cadence and disabled consumers do not participate', async () => {
  const oldSet = window.setInterval;
  const oldClear = window.clearInterval;
  const callbacks = new Map<number, () => void>();
  let sequence = 0;
  Object.defineProperty(window, 'setInterval', { configurable: true, writable: true, value: (callback: () => void, delay?: number) => {
    expect(delay).toBe(180000);
    callbacks.set(++sequence, callback);
    return sequence;
  } });
  Object.defineProperty(window, 'clearInterval', { configurable: true, writable: true, value: (id?: number) => { if (id !== undefined) callbacks.delete(id); } });
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    used = 100;
    initializeRuntimeEndpoint({ apiBaseUrl: 'http://localhost:3000', runtimeKey: 'local' });
    useConfigStore.setState({ isInitialized: true });
    useQuotaStore.setState({ loadedRuntimeKey: 'local', dropdownProviderIds: QUOTA_PROVIDERS.filter(provider => String(provider.id) === MITTR_PROVIDER_ID).map(provider => provider.id) });
    await act(async () => { root.render(<><MittrAIRefresh /><Picker open /><Cadence enabled /><Cadence enabled={false} /></>); });
    expect(callbacks.size).toBe(1);
    used = 5;
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      await act(async () => {
        for (const tick of callbacks.values()) tick();
        for (let wait = 0; wait < 20 && node.textContent !== 'ok'; wait += 1) await new Promise(resolve => setTimeout(resolve, 0));
      });
    } finally {
      Date.now = realNow;
    }
    expect(requests.some(path => path.includes('/api/mittr/quota/me'))).toBe(true);
    expect(node.textContent).toBe('ok');
    await act(async () => { root.render(<Cadence enabled={false} />); });
    expect(callbacks.size).toBe(0);
    await act(async () => { root.unmount(); });
  } finally {
    window.setInterval = oldSet;
    window.clearInterval = oldClear;
  }
});

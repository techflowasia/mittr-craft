import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from '../../../ui/node_modules/happy-dom';

const browser = new Window({ url: 'http://localhost/' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
const silentDebug = console.debug;
console.debug = () => {};

afterAll(() => {
  globalThis.fetch = realFetch;
  console.debug = silentDebug;
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const { createRoot } = await import('react-dom/client');
const { useGoalCheckAvailable } = await import('../../../ui/src/hooks/useSessionGoal');
const { useConfigStore } = await import('../../../ui/src/stores/useConfigStore');
const { selectSmallModelAvailability, useSmallModelStore } = await import('../../../ui/src/stores/useSmallModelStore');
const { setSignedInAccount } = await import('../sign-in/signedInAccount');
const { startMittrSmallModelRefresh, watchMittrSmallModel } = await import('./smallModelRefresh');

const DIRECTORY = '/work/app';

type ProviderList = ReturnType<typeof useConfigStore.getState>['providers'];

const providersWith = (mittrModels: string[], others: string[] = []): ProviderList => [
  ...(mittrModels.length ? [{ id: 'mittr', name: 'Mittr', models: mittrModels.map((id) => ({ id, name: id })) }] : []),
  ...(others.length ? [{ id: 'other', name: 'Other', models: others.map((id) => ({ id, name: id })) }] : []),
] as ProviderList;

const GoalProbe = () => <>{useGoalCheckAvailable(DIRECTORY, false) ? 'goal-check-on' : 'goal-check-off'}</>;

const mountGoalProbe = () => {
  const container = browser.document.createElement('div');
  browser.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(<GoalProbe />));
  return {
    text: () => container.textContent,
    unmount: () => act(() => root.unmount()),
  };
};

const seedUnavailable = async () => {
  const quietFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ available: false }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    useSmallModelStore.getState().invalidate();
    await useSmallModelStore.getState().ensureFresh(DIRECTORY);
  } finally {
    globalThis.fetch = quietFetch;
  }
};

const availability = () => selectSmallModelAvailability(useSmallModelStore.getState(), DIRECTORY);

afterEach(() => {
  setSignedInAccount(null);
  useConfigStore.setState({ providers: [] });
  useSmallModelStore.getState().invalidate();
});

describe('Small Model availability follows Mittr', () => {
  test('a cached unavailable from the cold start is cleared once Mittr models appear, and the goal check is then available', async () => {
    useConfigStore.setState({ providers: [] });
    await seedUnavailable();
    expect(availability()).toBe('unavailable');
    const stop = startMittrSmallModelRefresh();
    const probe = mountGoalProbe();
    try {
      expect(probe.text()).toBe('goal-check-off');
      act(() => useConfigStore.setState({ providers: providersWith(['mittr-fast']) }));
      expect(availability()).not.toBe('unavailable');
      expect(probe.text()).toBe('goal-check-on');
    } finally {
      probe.unmount();
      stop();
    }
  });

  test('finishing Mittr sign-in clears a cached unavailable', async () => {
    await seedUnavailable();
    const stop = startMittrSmallModelRefresh();
    const probe = mountGoalProbe();
    try {
      expect(probe.text()).toBe('goal-check-off');
      act(() => setSignedInAccount('user-1'));
      expect(availability()).not.toBe('unavailable');
      expect(probe.text()).toBe('goal-check-on');
    } finally {
      probe.unmount();
      stop();
    }
  });

  test('only a change in the Mittr model set, or a sign-in, asks again', () => {
    let models: string[] = [];
    let signedIn: string | null = null;
    const modelListeners = new Set<() => void>();
    const signInListeners = new Set<() => void>();
    let invalidated = 0;
    const stop = watchMittrSmallModel({
      mittrModels: () => models,
      subscribeModels: (listener) => { modelListeners.add(listener); return () => modelListeners.delete(listener); },
      signedIn: () => signedIn,
      subscribeSignedIn: (listener) => { signInListeners.add(listener); return () => signInListeners.delete(listener); },
      invalidate: () => { invalidated += 1; },
    });
    const modelsChanged = () => { for (const listener of [...modelListeners]) listener(); };
    const signInChanged = () => { for (const listener of [...signInListeners]) listener(); };

    expect(invalidated).toBe(0);
    modelsChanged();
    expect(invalidated).toBe(0);
    models = ['mittr-fast'];
    modelsChanged();
    expect(invalidated).toBe(1);
    modelsChanged();
    expect(invalidated).toBe(1);
    models = ['mittr-fast', 'mittr-pro'];
    modelsChanged();
    expect(invalidated).toBe(2);
    models = ['mittr-pro', 'mittr-fast'];
    modelsChanged();
    expect(invalidated).toBe(2);
    models = [];
    modelsChanged();
    expect(invalidated).toBe(3);

    signedIn = 'user-1';
    signInChanged();
    expect(invalidated).toBe(4);
    signedIn = null;
    signInChanged();
    expect(invalidated).toBe(4);

    stop();
    expect(modelListeners.size).toBe(0);
    expect(signInListeners.size).toBe(0);
  });

  test('a change to another provider only does not ask again', async () => {
    useConfigStore.setState({ providers: providersWith(['mittr-fast']) });
    const stop = startMittrSmallModelRefresh();
    try {
      await seedUnavailable();
      useConfigStore.setState({ providers: providersWith(['mittr-fast'], ['gpt']) });
      expect(availability()).toBe('unavailable');
    } finally {
      stop();
    }
  });
});

describe('MittrRoot', () => {
  test('starts the refresh outside the sign-in gate and stops it on unmount', async () => {
    const { MittrRoot } = await import('../MittrRoot');
    const { MittrSmallModelRefresh } = await import('./smallModelRefresh');
    const root = MittrRoot({ children: 'app', surface: 'main' });
    if (!React.isValidElement<{ children: React.ReactNode }>(root)) throw new Error('MittrRoot did not return an element');
    const outside = React.Children.toArray(root.props.children);
    expect(outside.some((child) => React.isValidElement(child) && child.type === MittrSmallModelRefresh)).toBe(true);

    await seedUnavailable();
    const container = browser.document.createElement('div');
    const mounted = createRoot(container as unknown as Element);
    act(() => mounted.render(<MittrSmallModelRefresh />));
    act(() => useConfigStore.setState({ providers: providersWith(['mittr-fast']) }));
    expect(availability()).not.toBe('unavailable');
    act(() => mounted.unmount());
    await seedUnavailable();
    act(() => useConfigStore.setState({ providers: providersWith(['mittr-pro']) }));
    expect(availability()).toBe('unavailable');
  });
});

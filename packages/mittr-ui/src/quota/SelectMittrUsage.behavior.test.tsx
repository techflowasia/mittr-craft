import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as RealReact from 'react';

type Effect = { run: () => void; deps: unknown[] | undefined };

let slots: Array<Effect | undefined> = [];
let slotIndex = 0;
let pending: Array<() => void> = [];

const sameDeps = (left?: unknown[], right?: unknown[]) =>
  Boolean(left && right) && left?.length === right?.length && left?.every((value, index) => Object.is(value, right?.[index]));

const useEffect = (run: () => void, deps?: unknown[]) => {
  const index = slotIndex++;
  if (!sameDeps(slots[index]?.deps, deps)) {
    slots[index] = { run, deps };
    pending.push(run);
  }
};

const ReactMock = {
  ...RealReact,
  useEffect,
  useCallback: <T,>(callback: T) => callback,
  useDebugValue: () => undefined,
  useSyncExternalStore: <T,>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
};

mock.module('react', () => ({ __esModule: true, ...ReactMock, default: ReactMock }));

const { useQuotaStore } = await import('../../../ui/src/stores/useQuotaStore');
const { SelectMittrUsage } = await import('./SelectMittrUsage');

const render = () => {
  slotIndex = 0;
  SelectMittrUsage();
  const effects = pending;
  pending = [];
  for (const run of effects) run();
};

describe('SelectMittrUsage', () => {
  beforeEach(() => {
    slots = [];
    pending = [];
    useQuotaStore.setState({ selectedProviderId: null });
  });

  test('selects Mittr when it mounts with nothing chosen', () => {
    render();
    expect(useQuotaStore.getState().selectedProviderId).toBe('mittr');
  });

  test('selects Mittr again after the selection is reset to nothing', () => {
    render();
    render();
    useQuotaStore.getState().resetForRuntimeSwitch();
    expect(useQuotaStore.getState().selectedProviderId).toBeNull();
    render();
    expect(useQuotaStore.getState().selectedProviderId).toBe('mittr');
  });

  test('never overrides a chosen provider', () => {
    useQuotaStore.setState({ selectedProviderId: 'codex' });
    render();
    render();
    expect(useQuotaStore.getState().selectedProviderId).toBe('codex');
  });
});

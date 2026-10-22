import type React from 'react';

import { subscribeRuntimeEndpointChanged } from '../../../ui/src/lib/runtime-switch';
import { registerTodaySection, type TodaySectionName } from '../today/todaySections';
import { createWidgetsApi, WidgetsRequestError, type WidgetsApi } from './widgetsApi';
import { WidgetsSection } from './WidgetsSection';

const NOT_THIS_MAC = 403;

type Register = (name: TodaySectionName, component: React.ComponentType) => () => void;

type Subscribe = (onChange: () => void) => () => void;

export async function widgetsHere(api: WidgetsApi): Promise<boolean> {
  try {
    return (await api.list()) !== 'absent';
  } catch (error) {
    return !(error instanceof WidgetsRequestError && error.status === NOT_THIS_MAC);
  }
}

export async function registerWidgetsSection({ api, register }: { api: WidgetsApi; register: Register }): Promise<boolean> {
  if (!(await widgetsHere(api))) return false;
  register('widgets', WidgetsSection);
  return true;
}

export function createWidgetsRegistration({ api, register, subscribe }: { api: WidgetsApi; register: Register; subscribe: Subscribe }): { ensure(): Promise<boolean> } {
  let started: Promise<boolean> | null = null;
  let unregister: (() => void) | null = null;
  let generation = 0;

  const check = async (): Promise<boolean> => {
    generation += 1;
    const mine = generation;
    const here = await widgetsHere(api);
    if (mine !== generation) return here;
    if (here && !unregister) unregister = register('widgets', WidgetsSection);
    if (!here && unregister) {
      unregister();
      unregister = null;
    }
    return here;
  };

  return {
    ensure: () => {
      if (!started) {
        subscribe(() => { void check(); });
        started = check();
      }
      return started;
    },
  };
}

let shared: { ensure(): Promise<boolean> } | null = null;

export function ensureWidgetsSection(): Promise<boolean> {
  shared ??= createWidgetsRegistration({ api: createWidgetsApi(), register: registerTodaySection, subscribe: (onChange) => subscribeRuntimeEndpointChanged(onChange) });
  return shared.ensure();
}

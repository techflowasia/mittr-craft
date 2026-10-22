import type React from 'react';

import { registerTodaySection, type TodaySectionName } from '../today/todaySections';
import { createWidgetsApi, WidgetsRequestError, type WidgetsApi } from './widgetsApi';
import { WidgetsSection } from './WidgetsSection';

const NOT_THIS_MAC = 403;

type Register = (name: TodaySectionName, component: React.ComponentType) => () => void;

export async function registerWidgetsSection({ api, register }: { api: WidgetsApi; register: Register }): Promise<boolean> {
  try {
    if ((await api.list()) === 'absent') return false;
  } catch (error) {
    if (error instanceof WidgetsRequestError && error.status === NOT_THIS_MAC) return false;
  }
  register('widgets', WidgetsSection);
  return true;
}

let started: Promise<boolean> | null = null;

export function ensureWidgetsSection(): Promise<boolean> {
  started ??= registerWidgetsSection({ api: createWidgetsApi(), register: registerTodaySection });
  return started;
}

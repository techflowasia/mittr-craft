import React from 'react';

import type { TodayRow } from './todayData';

export type TodaySectionName = 'widgets';

const sections = new Map<TodaySectionName, React.ComponentType>();
const extraAlerts = new Map<string, readonly TodayRow[]>();
let alertSnapshot: readonly TodayRow[] = [];
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of [...listeners]) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function registerTodaySection(name: TodaySectionName, component: React.ComponentType): () => void {
  sections.set(name, component);
  notify();
  return () => {
    if (sections.get(name) !== component) return;
    sections.delete(name);
    notify();
  };
}

export function setTodayAlerts(source: string, rows: readonly TodayRow[]): void {
  if (rows.length === 0 && !extraAlerts.has(source)) return;
  if (rows.length === 0) extraAlerts.delete(source);
  else extraAlerts.set(source, rows);
  alertSnapshot = [...extraAlerts.values()].flat();
  notify();
}

export function useTodaySection(name: TodaySectionName): React.ComponentType | null {
  const read = () => sections.get(name) ?? null;
  return React.useSyncExternalStore(subscribe, read, read);
}

export function useTodayExtraAlerts(): readonly TodayRow[] {
  const read = () => alertSnapshot;
  return React.useSyncExternalStore(subscribe, read, read);
}

import { mittrT } from '../strings/mittrT';
import type { TodayRow } from '../today/todayData';
import type { Widget, WidgetsApi } from './widgetsApi';

export type WidgetsState =
  | { status: 'loading' }
  | { status: 'absent' }
  | { status: 'error'; error: string }
  | { status: 'ready'; widgets: Widget[]; busy: string[]; switchedOn: boolean };

export type WidgetsController = {
  state(): WidgetsState;
  subscribe(fn: () => void): () => void;
  load(): Promise<void>;
  reload(): Promise<void>;
  enable(id: string, revision: string): Promise<string | null>;
  disable(id: string): Promise<string | null>;
  refresh(id: string): Promise<string | null>;
  remove(id: string): Promise<string | null>;
  dispose(): void;
};

export const WIDGETS_LOADING: WidgetsState = { status: 'loading' };

export function widgetAlerts(widgets: readonly Widget[], open: () => void): TodayRow[] {
  return widgets
    .filter((widget) => widget.alerting)
    .map((widget) => ({ id: `widget:${widget.id}`, kind: 'widget', title: widget.title, detail: mittrT('mittr.widgets.alerting'), open }));
}

export function createWidgetsController({ api }: { api: WidgetsApi }): WidgetsController {
  let current: WidgetsState = WIDGETS_LOADING;
  let generation = 0;
  let disposed = false;
  const listeners = new Set<() => void>();

  const set = (next: WidgetsState): void => {
    if (disposed || next === current) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };

  const load = async (): Promise<void> => {
    if (disposed) return;
    generation += 1;
    const request = generation;
    try {
      const list = await api.list();
      if (request !== generation) return;
      const busy = current.status === 'ready' ? current.busy : [];
      set(list === 'absent' ? { status: 'absent' } : { status: 'ready', widgets: list.widgets, busy, switchedOn: list.switchedOn });
    } catch (error) {
      if (request === generation) set({ status: 'error', error: error instanceof Error ? error.message : mittrT('mittr.widgets.errors.loadFailed') });
    }
  };

  const update = (change: (widgets: Widget[], busy: string[]) => { widgets: Widget[]; busy: string[] }): void => {
    if (current.status !== 'ready') return;
    set({ status: 'ready', switchedOn: current.switchedOn, ...change(current.widgets, current.busy) });
  };

  const run = async (id: string, send: () => Promise<Widget | null>): Promise<string | null> => {
    if (disposed || current.status !== 'ready' || current.busy.includes(id)) return null;
    generation += 1;
    update((widgets, busy) => ({ widgets, busy: [...busy, id] }));
    try {
      const answered = await send();
      update((widgets, busy) => ({
        widgets: answered ? widgets.map((widget) => (widget.id === id ? answered : widget)) : widgets.filter((widget) => widget.id !== id),
        busy: busy.filter((entry) => entry !== id),
      }));
      return null;
    } catch (error) {
      update((widgets, busy) => ({ widgets, busy: busy.filter((entry) => entry !== id) }));
      void load();
      return error instanceof Error ? error.message : mittrT('mittr.widgets.errors.actionFailed');
    }
  };

  return {
    state: () => current,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    load,
    reload: () => {
      set(WIDGETS_LOADING);
      return load();
    },
    enable: (id, revision) => run(id, () => api.enable(id, revision)),
    disable: (id) => run(id, () => api.disable(id)),
    refresh: (id) => run(id, () => api.refresh(id)),
    remove: (id) => run(id, async () => {
      await api.remove(id);
      return null;
    }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      generation += 1;
      listeners.clear();
    },
  };
}

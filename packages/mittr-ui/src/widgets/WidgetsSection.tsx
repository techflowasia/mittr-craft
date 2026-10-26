import React from 'react';

import { toast } from '../../../ui/src/components/ui';
import { listenAnyAccountChange } from '../sign-in/accountChange';
import { Button } from '../../../ui/src/components/ui/button';
import { useMittrT } from '../strings/mittrT';
import { setTodayAlerts } from '../today/todaySections';
import { WidgetCard } from './WidgetCard';
import { createWidgetsApi } from './widgetsApi';
import { createWidgetsController, WIDGETS_LOADING, widgetAlerts, type WidgetsController, type WidgetsState } from './widgetsController';
import './widgets.css';

const POLL_MS = 60_000;

export type WidgetsActions = {
  retry: () => void;
  enable: (id: string, revision: string) => void;
  disable: (id: string) => void;
  refresh: (id: string) => void;
  remove: (id: string) => void;
};

export function WidgetsSectionView({ state, actions }: { state: WidgetsState; actions: WidgetsActions }): React.ReactNode {
  const t = useMittrT();
  if (state.status === 'loading' || state.status === 'absent') return null;
  if (state.status === 'error') {
    return (
      <div className="mittr-widgets-failure">
        <p role="alert" className="mittr-widget-error">{state.error}</p>
        <Button type="button" size="xs" variant="outline" onClick={actions.retry}>{t('mittr.tools.actions.retry')}</Button>
      </div>
    );
  }
  if (state.widgets.length === 0) return <p className="mittr-today-empty">{t('mittr.widgets.empty')}</p>;
  return (
    <div className="mittr-widgets">
      {state.switchedOn ? null : <p className="mittr-widget-reason" role="status">{t('mittr.widgets.switchedOff')}</p>}
      {state.widgets.map((widget) => (
        <WidgetCard
          key={widget.id}
          widget={widget}
          busy={state.busy.includes(widget.id)}
          switchedOn={state.switchedOn}
          onEnable={actions.enable}
          onDisable={actions.disable}
          onRefresh={actions.refresh}
          onRemove={actions.remove}
        />
      ))}
    </div>
  );
}

const subscribeNothing = (): (() => void) => () => {};

const showRefusal = (refusal: string | null): void => {
  if (refusal) toast.error(refusal);
};

const NO_ACTIONS: WidgetsActions = { retry: () => {}, enable: () => {}, disable: () => {}, refresh: () => {}, remove: () => {} };

const actionsOf = (controller: WidgetsController): WidgetsActions => ({
  retry: () => { void controller.load(); },
  enable: (id, revision) => { void controller.enable(id, revision).then(showRefusal); },
  disable: (id) => { void controller.disable(id).then(showRefusal); },
  refresh: (id) => { void controller.refresh(id).then(showRefusal); },
  remove: (id) => { void controller.remove(id).then(showRefusal); },
});

function useWidgetsController(): WidgetsController | null {
  const [controller, setController] = React.useState<WidgetsController | null>(null);
  React.useEffect(() => {
    const created = createWidgetsController({ api: createWidgetsApi() });
    setController(created);
    void created.load();
    const timer = setInterval(() => { void created.load(); }, POLL_MS);
    const stopListening = listenAnyAccountChange(() => { void created.reload(); });
    return () => {
      clearInterval(timer);
      stopListening();
      created.dispose();
    };
  }, []);
  return controller;
}

export function WidgetsSection(): React.ReactNode {
  const controller = useWidgetsController();
  const read = React.useCallback(() => controller?.state() ?? WIDGETS_LOADING, [controller]);
  const state = React.useSyncExternalStore(controller ? controller.subscribe : subscribeNothing, read, read);
  const actions = React.useMemo(() => (controller ? actionsOf(controller) : NO_ACTIONS), [controller]);
  const widgets = state.status === 'ready' ? state.widgets : null;
  React.useEffect(() => {
    setTodayAlerts('widgets', widgets ? widgetAlerts(widgets, () => {
      document.querySelector('[data-today-section="widgets"]')?.scrollIntoView({ block: 'nearest' });
    }) : []);
  }, [widgets]);
  React.useEffect(() => () => setTodayAlerts('widgets', []), []);
  return <WidgetsSectionView state={state} actions={actions} />;
}

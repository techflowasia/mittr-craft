import React from 'react';

import { fetchScheduledTasks } from '../../../ui/src/lib/scheduledTasksApi';
import { useConfigStore } from '../../../ui/src/stores/useConfigStore';
import { useGlobalSessionsStore } from '../../../ui/src/stores/useGlobalSessionsStore';
import { useProjectsStore } from '../../../ui/src/stores/useProjectsStore';
import { useUIStore } from '../../../ui/src/stores/useUIStore';
import { useGlobalBlockingRequestsStore } from '../../../ui/src/sync/global-blocking-requests';
import { useGlobalSessionStatusStore } from '../../../ui/src/sync/global-session-status';
import { useNotificationStore } from '../../../ui/src/sync/notification-store';
import { useSessionUIStore } from '../../../ui/src/sync/session-ui-store';
import { MittrErrorBoundary } from '../MittrErrorBoundary';
import { useQuotaMe } from '../quota/quotaMeStore';
import { mittrT, useMittrT, type MittrKey } from '../strings/mittrT';
import { mittrAvailable, mittrCatalogAliases, planGoWork, startGoWork, type GoWorkProject } from '../work/goWork';
import { MyWorkDialog } from '../work/MyWorkDialog';
import { MY_WORK_LOADING, type MyWorkState } from '../work/myWorkController';
import { captureSendSelection } from '../work/sendSelection';
import type { WorkItem } from '../work/workItems';
import { sessionGoWorkDeps, useMyWorkController } from '../work/workSession';
import './today.css';
import { alerts, running, waiting, workRows, type ScheduledRun, type TodayKind, type TodayRow } from './todayData';
import { TodayLauncher } from './TodayLauncher';
import { useTodayExtraAlerts, useTodaySection } from './todaySections';
import { useToday } from './todayStore';

const WORK_ROWS_SHOWN = 5;
const SCHEDULED_POLL_MS = 60_000;
const CLOCK_TICK_MS = 60_000;

const kindLabelKey = (kind: TodayKind): MittrKey | null => {
  if (kind === 'approval') return 'mittr.today.kind.approval';
  if (kind === 'question') return 'mittr.today.kind.question';
  if (kind === 'review') return 'mittr.today.kind.review';
  if (kind === 'goal') return 'mittr.today.kind.goal';
  return null;
};

const greetingKey = (now: number): MittrKey => {
  const hour = new Date(now).getHours();
  if (hour < 12) return 'mittr.today.greeting.morning';
  if (hour < 18) return 'mittr.today.greeting.afternoon';
  return 'mittr.today.greeting.evening';
};

const waitingLine = (count: number): string => {
  if (count === 0) return mittrT('mittr.today.waitingCount.none');
  if (count === 1) return mittrT('mittr.today.waitingCount.one');
  return mittrT('mittr.today.waitingCount.many', { count });
};

const dateLine = (now: number): string => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(now);

function TodayRowButton({ row }: { row: TodayRow }): React.ReactNode {
  const kindKey = kindLabelKey(row.kind);
  return (
    <button type="button" className="mittr-today-row" data-kind={row.kind} onClick={row.open}>
      {row.kind === 'running' || row.kind === 'scheduled' ? <span className="mittr-today-dot" aria-hidden="true" /> : null}
      {kindKey ? <span className="mittr-today-kind">{mittrT(kindKey)}</span> : null}
      <span className="mittr-today-row-title">{row.title}</span>
      {row.detail ? <span className="mittr-today-row-detail">{row.detail}</span> : null}
    </button>
  );
}

function RowList({ rows, empty }: { rows: readonly TodayRow[]; empty: string }): React.ReactNode {
  if (rows.length === 0) return <p className="mittr-today-empty">{empty}</p>;
  return (
    <ul className="mittr-today-rows">
      {rows.map((row) => <li key={row.id}><TodayRowButton row={row} /></li>)}
    </ul>
  );
}

function WorkBody({ state, rows, onConnect, onMore }: { state: MyWorkState; rows: readonly TodayRow[]; onConnect: () => void; onMore: () => void }): React.ReactNode {
  const t = useMittrT();
  if (state.status === 'loading') return <p className="mittr-today-empty">{t('mittr.today.work.loading')}</p>;
  if (state.status === 'error') return <p className="mittr-today-empty" role="alert">{state.error ?? t('mittr.work.error')}</p>;
  if (state.status === 'not-connected') {
    return (
      <div className="mittr-today-connect">
        <p className="mittr-today-empty">{t('mittr.today.work.notConnected')}</p>
        <button type="button" className="mittr-today-link" onClick={onConnect}>{t('mittr.today.work.connect')}</button>
      </div>
    );
  }
  const more = rows.length - WORK_ROWS_SHOWN;
  return (
    <>
      <RowList rows={rows.slice(0, WORK_ROWS_SHOWN)} empty={t('mittr.today.work.empty')} />
      {more > 0 ? <button type="button" className="mittr-today-link" onClick={onMore}>{t('mittr.today.work.more', { count: more })}</button> : null}
    </>
  );
}

export type TodayViewProps = {
  now: number;
  waitingRows: readonly TodayRow[];
  runningRows: readonly TodayRow[];
  alertRows: readonly TodayRow[];
  work: MyWorkState;
  workItems: readonly TodayRow[];
  onConnectWork: () => void;
  onMoreWork: () => void;
  widgets: React.ComponentType | null;
  launcher: React.ReactNode;
};

export function TodayView({ now, waitingRows, runningRows, alertRows, work, workItems, onConnectWork, onMoreWork, widgets: Widgets, launcher }: TodayViewProps): React.ReactNode {
  const t = useMittrT();
  return (
    <section className="mittr-today" aria-label={t('mittr.today.title')}>
      <div className="mittr-today-inner">
        <header className="mittr-today-head">
          <h1 className="mittr-today-date">{dateLine(now)}</h1>
          <p className="mittr-today-greeting">{`${t(greetingKey(now))}. ${waitingLine(waitingRows.length)}`}</p>
        </header>
        {alertRows.length > 0 ? (
          <div className="mittr-today-alerts mittr-today-panel mittr-glass-panel" role="status">
            <span className="mittr-today-alerts-label"><span className="mittr-today-dot" data-tone="warn" aria-hidden="true" />{t('mittr.today.alerts.label')}</span>
            <ul className="mittr-today-alert-list">
              {alertRows.map((row) => (
                <li key={row.id}>
                  <button type="button" className="mittr-today-alert" data-kind={row.kind} onClick={row.open}>
                    {row.detail ? `${row.title} · ${row.detail}` : row.title}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="mittr-today-grid" data-columns={Widgets ? '3' : '2'}>
          <section className="mittr-today-panel mittr-glass-panel" aria-labelledby="mittr-today-waiting">
            <h2 id="mittr-today-waiting" className="mittr-today-panel-title">{t('mittr.today.panel.waiting')}</h2>
            <RowList rows={waitingRows} empty={t('mittr.today.waiting.empty')} />
            <h2 className="mittr-today-panel-title mittr-today-panel-title-next">{t('mittr.today.panel.running')}</h2>
            <RowList rows={runningRows} empty={t('mittr.today.running.empty')} />
          </section>
          <section className="mittr-today-panel mittr-glass-panel" aria-labelledby="mittr-today-work">
            <h2 id="mittr-today-work" className="mittr-today-panel-title">{t('mittr.today.panel.work')}</h2>
            <WorkBody state={work} rows={workItems} onConnect={onConnectWork} onMore={onMoreWork} />
          </section>
          {Widgets ? (
            <section className="mittr-today-panel mittr-glass-panel" aria-labelledby="mittr-today-widgets" data-today-section="widgets">
              <h2 id="mittr-today-widgets" className="mittr-today-panel-title">{t('mittr.today.panel.widgets')}</h2>
              <MittrErrorBoundary fallback={null}><Widgets /></MittrErrorBoundary>
            </section>
          ) : null}
        </div>
        <div className="mittr-today-launcher-row">{launcher}</div>
      </div>
    </section>
  );
}

const subscribeNothing = (): (() => void) => () => {};

function useNow(): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function useScheduledRuns(projects: readonly GoWorkProject[]): ScheduledRun[] {
  const [runs, setRuns] = React.useState<ScheduledRun[]>([]);
  const ids = projects.map((project) => project.id).join('\n');
  React.useEffect(() => {
    let live = true;
    const projectIds = ids ? ids.split('\n') : [];
    const load = async () => {
      const found = await Promise.all(projectIds.map(async (projectId) => {
        try {
          const tasks = await fetchScheduledTasks(projectId);
          return tasks.filter((task) => task.state?.lastStatus === 'running').map((task) => ({ id: task.id, name: task.name, projectId }));
        } catch {
          return [];
        }
      }));
      if (live) setRuns(found.flat());
    };
    void load();
    const timer = setInterval(() => { void load(); }, SCHEDULED_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [ids]);
  return runs;
}

function TodayContent({ hide }: { hide: () => void }): React.ReactNode {
  const now = useNow();
  const sessions = useGlobalSessionsStore((state) => state.activeSessions);
  const statusById = useGlobalSessionStatusStore((state) => state.statusById);
  const blocking = useGlobalBlockingRequestsStore((state) => state.bySession);
  const notifications = useNotificationStore((state) => state.index.session);
  const quota = useQuotaMe(true);
  const controller = useMyWorkController();
  const work = React.useSyncExternalStore(
    controller ? controller.subscribe : subscribeNothing,
    () => (controller ? controller.state() : MY_WORK_LOADING),
    () => MY_WORK_LOADING,
  );
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const [chosenProjectId, setChosenProjectId] = React.useState<string | null>(null);
  const project = projects.find((entry) => entry.id === chosenProjectId)
    ?? projects.find((entry) => entry.id === activeProjectId)
    ?? projects[0]
    ?? null;
  const scheduled = useScheduledRuns(projects);
  const extraAlerts = useTodayExtraAlerts();
  const widgets = useTodaySection('widgets');
  const [myWorkOpen, setMyWorkOpen] = React.useState(false);
  const goWorkRunning = React.useRef(false);
  const agentStatus = quota.status === 'ok' ? quota.quota.agentStatus : null;

  const startWork = (item: WorkItem) => {
    const plan = () => {
      const selection = captureSendSelection();
      const available = mittrAvailable(selection, mittrCatalogAliases(useConfigStore.getState().providers), agentStatus);
      return planGoWork({ item, project, selection, available, listIsForCurrentAccount: controller?.listIsForCurrentAccount() ?? false });
    };
    void startGoWork(goWorkRunning, () => {}, item.id, plan, sessionGoWorkDeps(hide, () => { void controller?.refresh(); }));
  };

  const state = {
    sessions,
    statusById,
    blocking,
    unseenCount: notifications.unseenCount,
    unseenHasError: notifications.unseenHasError,
    quota,
    work,
    scheduled,
    now,
    go: {
      session: (id: string, directory: string | null) => {
        hide();
        useSessionUIStore.getState().setCurrentSession(id, directory);
      },
      settings: (page: string) => {
        const ui = useUIStore.getState();
        ui.setSettingsPage(page);
        ui.setSettingsDialogOpen(true);
      },
      work: startWork,
      scheduledTasks: () => useUIStore.getState().setScheduledTasksDialogOpen(true),
    },
  };

  return (
    <>
      <TodayView
        now={now}
        waitingRows={waiting(state)}
        runningRows={running(state)}
        alertRows={[...alerts(state), ...extraAlerts]}
        work={work}
        workItems={workRows(state)}
        onConnectWork={() => state.go.settings('integrations')}
        onMoreWork={() => setMyWorkOpen(true)}
        widgets={widgets}
        launcher={<TodayLauncher projects={projects} project={project} onProject={(entry) => setChosenProjectId(entry.id)} hide={hide} />}
      />
      <MyWorkDialog open={myWorkOpen} onOpenChange={setMyWorkOpen} />
    </>
  );
}

export function TodayPage(): React.ReactNode {
  const today = useToday();
  if (!today.open) return null;
  return (
    <MittrErrorBoundary fallback={null}>
      <TodayContent hide={today.hide} />
    </MittrErrorBoundary>
  );
}

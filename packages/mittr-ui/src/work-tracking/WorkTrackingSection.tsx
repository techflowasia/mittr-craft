import React from 'react';

import { Icon } from '../../../ui/src/components/icon/Icon';
import {
  SETTINGS_HELPER_CLASS,
  SettingsControlGroup,
  SettingsSection,
  SettingsStackedField,
} from '../../../ui/src/components/sections/shared/SettingsSection';
import { toast } from '../../../ui/src/components/ui';
import { Button } from '../../../ui/src/components/ui/button';
import { Input } from '../../../ui/src/components/ui/input';
import { useI18n } from '../../../ui/src/lib/i18n';
import { cn } from '../../../ui/src/lib/utils';
import { MittrErrorBoundary } from '../MittrErrorBoundary';
import { listenAnyAccountChange } from '../sign-in/accountChange';
import { signedInAccount } from '../sign-in/signedInAccount';
import { useMittrT } from '../strings/mittrT';
import { createIntegrationsApi } from './integrationsApi';
import {
  createWorkTrackingController,
  WORK_TRACKING_LOADING,
  type WorkTrackingController,
  type WorkTrackingOutcome,
  type WorkTrackingState,
  type WorkTrackingTask,
} from './workTrackingController';
import { KEEP_PLACEHOLDER, multiWorkspaceSupported, slugsOf, type JiraForm, type PlaneForm } from './workTrackingForm';

export type WorkTrackingActions = {
  refresh: () => void;
  editJira: (patch: Partial<JiraForm>) => void;
  editPlane: (patch: Partial<Pick<PlaneForm, 'baseUrl' | 'apiKey'>>) => void;
  editNewWorkspace: (text: string) => void;
  addWorkspace: () => void;
  removeWorkspace: (slug: string) => void;
  saveJira: () => void;
  savePlane: () => void;
  testJira: () => void;
  testPlane: () => void;
};

type WorkTrackingSectionViewProps = { state: WorkTrackingState; actions: WorkTrackingActions };

const CARD_CLASS = 'space-y-3 rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-4';
const FIELDS_CLASS = 'grid gap-3 @xl:grid-cols-2';
const WIDE_FIELD_CLASS = 'col-span-full';
const ALERT_CLASS = 'rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2 typography-micro text-[var(--status-error)]';
const NOTICE_CLASS = 'rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-3 py-2 typography-micro text-[var(--status-warning)]';
const WORKSPACE_ERROR_ID = 'mittr-plane-workspace-error';

function StatusBadge({ connected }: { connected: boolean }): React.ReactNode {
  const t = useMittrT();
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 typography-micro font-medium',
        connected ? 'bg-[var(--status-success)]/15 text-[var(--status-success)]' : 'bg-[var(--surface-muted)] text-muted-foreground',
      )}
    >
      {connected ? t('mittr.workTracking.status.connected') : t('mittr.workTracking.status.notConnected')}
    </span>
  );
}

function CardHeader({ name, connected }: { name: string; connected: boolean }): React.ReactNode {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="typography-ui-label font-medium text-foreground">{name}</span>
      <StatusBadge connected={connected} />
    </div>
  );
}

function SecretLabel({ label, saved }: { label: string; saved: boolean }): React.ReactNode {
  const t = useMittrT();
  return (
    <>
      {label}
      {saved ? <>{' '}<span className="text-muted-foreground/70">{t('mittr.workTracking.hasSavedValue')}</span></> : null}
    </>
  );
}

type CardActionsProps = {
  busy: readonly WorkTrackingTask[];
  saveTask: WorkTrackingTask;
  testTask: WorkTrackingTask;
  canTest: boolean;
  saved: boolean;
  onSave: () => void;
  onTest: () => void;
};

function CardActions({ busy, saveTask, testTask, canTest, saved, onSave, onTest }: CardActionsProps): React.ReactNode {
  const { t } = useI18n();
  const mt = useMittrT();
  const saving = busy.includes(saveTask);
  const testing = busy.includes(testTask);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={onSave} disabled={saving}>
          {saving ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
          {t('settings.common.actions.saveChanges')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onTest} disabled={testing || !canTest}>
          {testing ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
          {mt('mittr.workTracking.actions.test')}
        </Button>
      </div>
      {saved ? <p role="status" className={SETTINGS_HELPER_CLASS}>{mt('mittr.workTracking.savedNote')}</p> : null}
    </div>
  );
}

function JiraCard({ state, actions }: WorkTrackingSectionViewProps): React.ReactNode {
  const t = useMittrT();
  const jira = state.config?.jira;
  const hasToken = jira?.hasToken ?? false;
  return (
    <div className={CARD_CLASS}>
      <CardHeader name={t('mittr.work.source.jira')} connected={jira?.configured ?? false} />
      <div className={FIELDS_CLASS}>
        <SettingsStackedField label={t('mittr.workTracking.jira.baseUrl')}>
          <Input
            aria-label={t('mittr.workTracking.jira.baseUrl')}
            value={state.jira.baseUrl}
            onChange={(event) => actions.editJira({ baseUrl: event.target.value })}
            placeholder={t('mittr.workTracking.jira.baseUrlPlaceholder')}
          />
        </SettingsStackedField>
        <SettingsStackedField label={t('mittr.workTracking.jira.email')}>
          <Input
            aria-label={t('mittr.workTracking.jira.email')}
            value={state.jira.email}
            onChange={(event) => actions.editJira({ email: event.target.value })}
            placeholder={t('mittr.workTracking.jira.emailPlaceholder')}
          />
        </SettingsStackedField>
        <SettingsStackedField className={WIDE_FIELD_CLASS} label={<SecretLabel label={t('mittr.workTracking.jira.apiToken')} saved={hasToken} />}>
          <Input
            type="password"
            aria-label={t('mittr.workTracking.jira.apiToken')}
            value={state.jira.token}
            onChange={(event) => actions.editJira({ token: event.target.value })}
            placeholder={hasToken ? KEEP_PLACEHOLDER : ''}
          />
        </SettingsStackedField>
      </div>
      <CardActions
        busy={state.busy}
        saveTask="saveJira"
        testTask="testJira"
        canTest={jira?.configured ?? false}
        saved={state.savedNote === 'jira'}
        onSave={actions.saveJira}
        onTest={actions.testJira}
      />
    </div>
  );
}

function WorkspaceRow({ slug, state, onRemove }: { slug: string; state: WorkTrackingState; onRemove: (slug: string) => void }): React.ReactNode {
  const t = useMittrT();
  const saved = state.config ? slugsOf(state.config.plane).includes(slug) : false;
  const test = state.workspaceTests[slug];
  const remove = t('mittr.workTracking.plane.removeWorkspace', { slug });
  return (
    <li className="flex min-h-10 items-center gap-2 px-3 py-1.5">
      <Icon name="stack" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate typography-ui-label font-mono text-foreground" title={slug}>{slug}</span>
      {!saved ? (
        <span className="shrink-0 typography-micro text-muted-foreground">{t('mittr.workTracking.plane.unsaved')}</span>
      ) : test ? (
        <span
          className={cn('flex min-w-0 shrink items-center gap-1 typography-micro', test.ok ? 'text-[var(--status-success)]' : 'text-[var(--status-error)]')}
          title={test.error}
        >
          <Icon name={test.ok ? 'checkbox-circle' : 'error-warning'} className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">
            {test.ok
              ? t('mittr.workTracking.plane.workspaceOk', { count: test.count })
              : t('mittr.workTracking.plane.workspaceFailed', { error: test.error ?? '' })}
          </span>
        </span>
      ) : null}
      <Button type="button" size="sm" variant="ghost" className="shrink-0" aria-label={remove} title={remove} onClick={() => onRemove(slug)}>
        <Icon name="close" className="size-3.5" aria-hidden="true" />
      </Button>
    </li>
  );
}

function PlaneCard({ state, actions }: WorkTrackingSectionViewProps): React.ReactNode {
  const t = useMittrT();
  const plane = state.config?.plane;
  const hasApiKey = plane?.hasApiKey ?? false;
  const multi = state.config ? multiWorkspaceSupported(state.config) : false;
  const slugs = state.plane.workspaceSlugs;
  const canAdd = multi || slugs.length === 0;
  return (
    <div className={CARD_CLASS}>
      <CardHeader name={t('mittr.work.source.plane')} connected={plane?.configured ?? false} />
      <div className={FIELDS_CLASS}>
        <SettingsStackedField label={t('mittr.workTracking.plane.baseUrl')}>
          <Input
            aria-label={t('mittr.workTracking.plane.baseUrl')}
            value={state.plane.baseUrl}
            onChange={(event) => actions.editPlane({ baseUrl: event.target.value })}
            placeholder={t('mittr.workTracking.plane.baseUrlPlaceholder')}
          />
        </SettingsStackedField>
        <SettingsStackedField className={WIDE_FIELD_CLASS} label={<SecretLabel label={t('mittr.workTracking.plane.token')} saved={hasApiKey} />}>
          <Input
            type="password"
            aria-label={t('mittr.workTracking.plane.token')}
            value={state.plane.apiKey}
            onChange={(event) => actions.editPlane({ apiKey: event.target.value })}
            placeholder={hasApiKey ? KEEP_PLACEHOLDER : ''}
          />
        </SettingsStackedField>
      </div>
      <SettingsControlGroup
        title={multi ? t('mittr.workTracking.plane.workspaces') : t('mittr.workTracking.plane.workspaceSlug')}
        description={multi ? t('mittr.workTracking.plane.workspacesHint') : t('mittr.workTracking.plane.singleWorkspace')}
        contentClassName="space-y-2"
      >
        {slugs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-2 typography-micro text-muted-foreground">
            {t('mittr.workTracking.plane.noWorkspaces')}
          </p>
        ) : (
          <ul className="divide-y divide-[var(--interactive-border)] rounded-lg border border-[var(--interactive-border)]">
            {slugs.map((slug) => <WorkspaceRow key={slug} slug={slug} state={state} onRemove={actions.removeWorkspace} />)}
          </ul>
        )}
        {canAdd ? (
          <div className="flex max-w-[24rem] items-start gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <Input
                aria-label={t('mittr.workTracking.plane.newWorkspace')}
                value={state.newWorkspace}
                onChange={(event) => actions.editNewWorkspace(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  actions.addWorkspace();
                }}
                placeholder={t('mittr.workTracking.plane.newWorkspacePlaceholder')}
                aria-invalid={state.workspaceError ? true : undefined}
                aria-describedby={state.workspaceError ? WORKSPACE_ERROR_ID : undefined}
              />
              {state.workspaceError ? (
                <span id={WORKSPACE_ERROR_ID} role="alert" className="block typography-micro text-[var(--status-error)]">
                  {state.workspaceError}
                </span>
              ) : null}
            </div>
            <Button type="button" size="sm" variant="outline" onClick={actions.addWorkspace} disabled={!state.newWorkspace.trim()}>
              <Icon name="add" className="size-3.5" aria-hidden="true" />
              {t('mittr.workTracking.plane.addWorkspace')}
            </Button>
          </div>
        ) : null}
      </SettingsControlGroup>
      <CardActions
        busy={state.busy}
        saveTask="savePlane"
        testTask="testPlane"
        canTest={plane?.configured ?? false}
        saved={state.savedNote === 'plane'}
        onSave={actions.savePlane}
        onTest={actions.testPlane}
      />
    </div>
  );
}

export function WorkTrackingSectionView({ state, actions }: WorkTrackingSectionViewProps): React.ReactNode {
  const { t } = useI18n();
  const mt = useMittrT();

  const body = (): React.ReactNode => {
    if (state.status === 'loading') return <p className={SETTINGS_HELPER_CLASS}>{t('common.loading')}</p>;
    if (state.status === 'error' || !state.loadedFor) {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className={ALERT_CLASS}>{state.error ?? mt('mittr.workTracking.errors.loadFailed')}</p>
          <Button type="button" size="sm" variant="outline" onClick={actions.refresh}>{mt('mittr.workTracking.actions.retry')}</Button>
        </div>
      );
    }
    return (
      <>
        {state.notice ? <p role="status" className={NOTICE_CLASS}>{state.notice}</p> : null}
        <JiraCard state={state} actions={actions} />
        <PlaneCard state={state} actions={actions} />
      </>
    );
  };

  return (
    <SettingsSection title={mt('mittr.workTracking.title')} info={mt('mittr.workTracking.info')} contentClassName="space-y-4">
      {body()}
    </SettingsSection>
  );
}

const subscribeNothing = (): (() => void) => () => {};

const showOutcome = (outcome: WorkTrackingOutcome): void => {
  if (!outcome) return;
  if (outcome.tone === 'success') toast.success(outcome.text);
  else toast.error(outcome.text);
};

const NO_ACTIONS: WorkTrackingActions = {
  refresh: () => {},
  editJira: () => {},
  editPlane: () => {},
  editNewWorkspace: () => {},
  addWorkspace: () => {},
  removeWorkspace: () => {},
  saveJira: () => {},
  savePlane: () => {},
  testJira: () => {},
  testPlane: () => {},
};

const actionsOf = (controller: WorkTrackingController): WorkTrackingActions => {
  const run = (task: () => Promise<WorkTrackingOutcome>) => () => { void task().then(showOutcome); };
  return {
    refresh: () => { void controller.refresh(); },
    editJira: controller.editJira,
    editPlane: controller.editPlane,
    editNewWorkspace: controller.editNewWorkspace,
    addWorkspace: controller.addWorkspace,
    removeWorkspace: controller.removeWorkspace,
    saveJira: run(controller.saveJira),
    savePlane: run(controller.savePlane),
    testJira: run(controller.testJira),
    testPlane: run(controller.testPlane),
  };
};

function useWorkTrackingController(): WorkTrackingController | null {
  const [controller, setController] = React.useState<WorkTrackingController | null>(null);
  React.useEffect(() => {
    const created = createWorkTrackingController({
      api: createIntegrationsApi(),
      currentUserId: signedInAccount,
      listenAccountChanged: listenAnyAccountChange,
    });
    setController(created);
    void created.refresh();
    return () => created.dispose();
  }, []);
  return controller;
}

export function WorkTrackingSection(): React.ReactNode {
  const controller = useWorkTrackingController();
  const read = React.useCallback(() => controller?.state() ?? WORK_TRACKING_LOADING, [controller]);
  const state = React.useSyncExternalStore(controller ? controller.subscribe : subscribeNothing, read, read);
  const actions = React.useMemo(() => (controller ? actionsOf(controller) : NO_ACTIONS), [controller]);
  return <WorkTrackingSectionView state={state} actions={actions} />;
}

export function WorkTrackingSettingsItem(): React.ReactNode {
  return (
    <MittrErrorBoundary fallback={null}>
      <WorkTrackingSection />
    </MittrErrorBoundary>
  );
}

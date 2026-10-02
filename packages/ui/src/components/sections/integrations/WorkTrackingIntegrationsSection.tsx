import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  fetchMittrIntegrations,
  saveMittrIntegrations,
  testMittrJira,
  testMittrPlane,
  type MittrIntegrationsConfig,
  type MittrPlaneConfig,
  type MittrPlaneWorkspaceTest,
} from '@/lib/mittrIntegrationsApi';

const KEEP_PLACEHOLDER = '••••••••••••';

type JiraForm = { baseUrl: string; email: string; token: string };
type PlaneForm = { baseUrl: string; workspaceSlugs: string[]; apiKey: string };

const emptyJira: JiraForm = { baseUrl: '', email: '', token: '' };
const emptyPlane: PlaneForm = { baseUrl: '', workspaceSlugs: [], apiKey: '' };

const slugsOf = (plane: MittrPlaneConfig): string[] => {
  if (plane.workspaceSlugs?.length) return plane.workspaceSlugs;
  return plane.workspaceSlug ? [plane.workspaceSlug] : [];
};

const planeFormOf = (plane: MittrPlaneConfig): PlaneForm => ({
  baseUrl: plane.baseUrl,
  workspaceSlugs: slugsOf(plane),
  apiKey: '',
});

const slugFromInput = (value: string): string => {
  const text = value.trim();
  const fromUrl = /^https?:\/\/[^/]+\/([^/?#]+)/i.exec(text);
  return (fromUrl?.[1] ?? text).replace(/^\/+|\/+$/g, '');
};

function Badge({ connected }: { connected: boolean }) {
  const { t } = useI18n();
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
        connected
          ? 'bg-[var(--status-success)]/15 text-[var(--status-success)]'
          : 'bg-[var(--surface-muted)] text-muted-foreground',
      )}
    >
      {connected
        ? t('settings.integrations.workTracking.status.connected')
        : t('settings.integrations.workTracking.status.notConnected')}
    </span>
  );
}

export const WorkTrackingIntegrationsSection: React.FC = () => {
  const { t } = useI18n();
  const [config, setConfig] = React.useState<MittrIntegrationsConfig | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [jira, setJira] = React.useState<JiraForm>(emptyJira);
  const [plane, setPlane] = React.useState<PlaneForm>(emptyPlane);
  const [savingJira, setSavingJira] = React.useState(false);
  const [savingPlane, setSavingPlane] = React.useState(false);
  const [testingJira, setTestingJira] = React.useState(false);
  const [testingPlane, setTestingPlane] = React.useState(false);
  const [newWorkspace, setNewWorkspace] = React.useState('');
  const [workspaceError, setWorkspaceError] = React.useState<string | null>(null);
  const [workspaceTests, setWorkspaceTests] = React.useState<Record<string, MittrPlaneWorkspaceTest>>({});

  const load = React.useCallback(async () => {
    try {
      const cfg = await fetchMittrIntegrations();
      setConfig(cfg);
      setJira({ baseUrl: cfg.jira.baseUrl, email: cfg.jira.email, token: '' });
      setPlane(planeFormOf(cfg.plane));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t('settings.integrations.workTracking.errors.loadFailed'));
    }
  }, [t]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const handleSaveJira = React.useCallback(async () => {
    setSavingJira(true);
    try {
      const cfg = await saveMittrIntegrations({
        jira: {
          baseUrl: jira.baseUrl,
          email: jira.email,
          ...(jira.token ? { token: jira.token } : {}),
        },
      });
      setConfig(cfg);
      setJira({ baseUrl: cfg.jira.baseUrl, email: cfg.jira.email, token: '' });
      toast.success(t('settings.integrations.workTracking.toast.saved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.integrations.workTracking.toast.saveFailed'));
    } finally {
      setSavingJira(false);
    }
  }, [jira, t]);

  const handleSavePlane = React.useCallback(async () => {
    setSavingPlane(true);
    try {
      const cfg = await saveMittrIntegrations({
        plane: {
          baseUrl: plane.baseUrl,
          workspaceSlug: plane.workspaceSlugs[0] ?? '',
          workspaceSlugs: plane.workspaceSlugs,
          ...(plane.apiKey ? { apiKey: plane.apiKey } : {}),
        },
      });
      setConfig(cfg);
      setPlane(planeFormOf(cfg.plane));
      toast.success(t('settings.integrations.workTracking.toast.saved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.integrations.workTracking.toast.saveFailed'));
    } finally {
      setSavingPlane(false);
    }
  }, [plane, t]);

  const handleTestJira = React.useCallback(async () => {
    setTestingJira(true);
    try {
      const result = await testMittrJira();
      if (result.ok) {
        toast.success(t('settings.integrations.workTracking.toast.testOk', { name: result.displayName ?? result.email ?? '' }));
      } else {
        toast.error(result.error ?? t('settings.integrations.workTracking.toast.testFailed'));
      }
    } finally {
      setTestingJira(false);
    }
  }, [t]);

  const handleTestPlane = React.useCallback(async () => {
    setTestingPlane(true);
    try {
      const result = await testMittrPlane();
      setWorkspaceTests(Object.fromEntries((result.workspaces ?? []).map((entry) => [entry.slug, entry])));
      if (result.ok) {
        toast.success(
          result.workspaces && result.workspaces.length > 1
            ? t('settings.integrations.workTracking.toast.testOkWorkspaces', { count: result.count ?? 0, workspaces: result.workspaces.length })
            : t('settings.integrations.workTracking.toast.testOkCount', { count: result.count ?? 0 }),
        );
      } else {
        toast.error(result.error ?? t('settings.integrations.workTracking.toast.testFailed'));
      }
    } finally {
      setTestingPlane(false);
    }
  }, [t]);

  const savedSlugs = React.useMemo(() => (config ? slugsOf(config.plane) : []), [config]);

  const addWorkspace = React.useCallback(() => {
    const slug = slugFromInput(newWorkspace);
    if (!slug) return;
    if (plane.workspaceSlugs.includes(slug)) {
      setWorkspaceError(t('settings.integrations.workTracking.plane.duplicateWorkspace', { slug }));
      return;
    }
    setPlane({ ...plane, workspaceSlugs: [...plane.workspaceSlugs, slug] });
    setNewWorkspace('');
    setWorkspaceError(null);
  }, [newWorkspace, plane, t]);

  const removeWorkspace = React.useCallback((slug: string) => {
    setPlane({ ...plane, workspaceSlugs: plane.workspaceSlugs.filter((entry) => entry !== slug) });
  }, [plane]);

  return (
    <SettingsSection
      title={t('settings.integrations.workTracking.title')}
      info={t('settings.integrations.workTracking.info')}
      divider={false}
      settingsItem="integrations.work-tracking"
      contentClassName="space-y-4"
    >
      {loadError ? (
        <p className="rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2 typography-micro text-[var(--status-error)]">
          {loadError}
        </p>
      ) : null}

      <div className="space-y-3 rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="typography-ui-label font-medium text-foreground">Jira</span>
          <Badge connected={config?.jira.configured ?? false} />
        </div>
        <div className="grid gap-3 @lg:grid-cols-2">
          <label className="space-y-1.5">
            <span className="typography-micro text-muted-foreground">{t('settings.integrations.workTracking.jira.baseUrl')}</span>
            <Input
              value={jira.baseUrl}
              onChange={(e) => setJira({ ...jira, baseUrl: e.target.value })}
              placeholder="https://your-site.atlassian.net"
            />
          </label>
          <label className="space-y-1.5">
            <span className="typography-micro text-muted-foreground">{t('settings.integrations.workTracking.jira.email')}</span>
            <Input
              value={jira.email}
              onChange={(e) => setJira({ ...jira, email: e.target.value })}
              placeholder="you@company.com"
            />
          </label>
          <label className="space-y-1.5 @lg:col-span-2">
            <span className="typography-micro text-muted-foreground">
              {t('settings.integrations.workTracking.jira.apiToken')}{' '}
              {config?.jira.hasToken ? (
                <span className="text-muted-foreground/70">{t('settings.integrations.workTracking.hasSavedValue')}</span>
              ) : null}
            </span>
            <Input
              type="password"
              value={jira.token}
              onChange={(e) => setJira({ ...jira, token: e.target.value })}
              placeholder={config?.jira.hasToken ? KEEP_PLACEHOLDER : ''}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={() => void handleSaveJira()} disabled={savingJira}>
            {savingJira ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
            {t('settings.common.actions.saveChanges')}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void handleTestJira()} disabled={testingJira || !config?.jira.configured}>
            {testingJira ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
            {t('settings.integrations.workTracking.actions.test')}
          </Button>
        </div>
      </div>

      <div className="space-y-3 rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="typography-ui-label font-medium text-foreground">Plane</span>
          <Badge connected={config?.plane.configured ?? false} />
        </div>
        <div className="grid gap-3 @lg:grid-cols-2">
          <label className="space-y-1.5">
            <span className="typography-micro text-muted-foreground">{t('settings.integrations.workTracking.plane.baseUrl')}</span>
            <Input
              value={plane.baseUrl}
              onChange={(e) => setPlane({ ...plane, baseUrl: e.target.value })}
              placeholder="https://plane.your-company.com"
            />
          </label>
          <label className="space-y-1.5 @lg:col-span-2">
            <span className="typography-micro text-muted-foreground">
              {t('settings.integrations.workTracking.plane.token')}{' '}
              {config?.plane.hasApiKey ? (
                <span className="text-muted-foreground/70">{t('settings.integrations.workTracking.hasSavedValue')}</span>
              ) : null}
            </span>
            <Input
              type="password"
              value={plane.apiKey}
              onChange={(e) => setPlane({ ...plane, apiKey: e.target.value })}
              placeholder={config?.plane.hasApiKey ? KEEP_PLACEHOLDER : ''}
            />
          </label>
        </div>
        <fieldset className="space-y-2">
          <legend className="typography-micro text-muted-foreground">{t('settings.integrations.workTracking.plane.workspaces')}</legend>
          <p className="typography-micro text-muted-foreground/80">{t('settings.integrations.workTracking.plane.workspacesHint')}</p>
          {plane.workspaceSlugs.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-2 typography-micro text-muted-foreground">
              {t('settings.integrations.workTracking.plane.noWorkspaces')}
            </p>
          ) : (
            <ul className="divide-y divide-[var(--interactive-border)] rounded-lg border border-[var(--interactive-border)]">
              {plane.workspaceSlugs.map((slug) => {
                const test = workspaceTests[slug];
                const unsaved = !savedSlugs.includes(slug);
                return (
                  <li key={slug} className="flex min-h-10 items-center gap-2 px-3 py-1.5">
                    <Icon name="stack" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate typography-ui-label font-mono text-foreground" title={slug}>{slug}</span>
                    {unsaved ? (
                      <span className="shrink-0 typography-micro text-muted-foreground">{t('settings.integrations.workTracking.plane.unsaved')}</span>
                    ) : test ? (
                      <span
                        className={cn(
                          'flex min-w-0 shrink items-center gap-1 typography-micro',
                          test.ok ? 'text-[var(--status-success)]' : 'text-[var(--status-error)]',
                        )}
                        title={test.error}
                      >
                        <Icon name={test.ok ? 'checkbox-circle' : 'error-warning'} className="size-3.5 shrink-0" aria-hidden="true" />
                        <span className="truncate">
                          {test.ok
                            ? t('settings.integrations.workTracking.plane.workspaceOk', { count: test.count })
                            : t('settings.integrations.workTracking.plane.workspaceFailed', { error: test.error ?? '' })}
                        </span>
                      </span>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="shrink-0"
                      aria-label={t('settings.integrations.workTracking.plane.removeWorkspace', { slug })}
                      title={t('settings.integrations.workTracking.plane.removeWorkspace', { slug })}
                      onClick={() => removeWorkspace(slug)}
                    >
                      <Icon name="close" className="size-3.5" aria-hidden="true" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex items-start gap-2">
            <label className="min-w-0 flex-1 space-y-1">
              <span className="sr-only">{t('settings.integrations.workTracking.plane.newWorkspace')}</span>
              <Input
                value={newWorkspace}
                onChange={(e) => {
                  setNewWorkspace(e.target.value);
                  setWorkspaceError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addWorkspace();
                  }
                }}
                placeholder="your-workspace"
                aria-invalid={workspaceError ? true : undefined}
                aria-describedby={workspaceError ? 'plane-workspace-error' : undefined}
              />
              {workspaceError ? (
                <span id="plane-workspace-error" role="alert" className="block typography-micro text-[var(--status-error)]">
                  {workspaceError}
                </span>
              ) : null}
            </label>
            <Button type="button" size="sm" variant="outline" onClick={addWorkspace} disabled={!newWorkspace.trim()}>
              <Icon name="add" className="size-3.5" aria-hidden="true" />
              {t('settings.integrations.workTracking.plane.addWorkspace')}
            </Button>
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={() => void handleSavePlane()} disabled={savingPlane}>
            {savingPlane ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
            {t('settings.common.actions.saveChanges')}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void handleTestPlane()} disabled={testingPlane || !config?.plane.configured}>
            {testingPlane ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
            {t('settings.integrations.workTracking.actions.test')}
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
};

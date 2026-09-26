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
} from '@/lib/mittrIntegrationsApi';

const KEEP_PLACEHOLDER = '••••••••••••';

type JiraForm = { baseUrl: string; email: string; token: string };
type PlaneForm = { baseUrl: string; workspaceSlug: string; apiKey: string };

const emptyJira: JiraForm = { baseUrl: '', email: '', token: '' };
const emptyPlane: PlaneForm = { baseUrl: '', workspaceSlug: '', apiKey: '' };

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

  const load = React.useCallback(async () => {
    try {
      const cfg = await fetchMittrIntegrations();
      setConfig(cfg);
      setJira({ baseUrl: cfg.jira.baseUrl, email: cfg.jira.email, token: '' });
      setPlane({ baseUrl: cfg.plane.baseUrl, workspaceSlug: cfg.plane.workspaceSlug, apiKey: '' });
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
          workspaceSlug: plane.workspaceSlug,
          ...(plane.apiKey ? { apiKey: plane.apiKey } : {}),
        },
      });
      setConfig(cfg);
      setPlane({ baseUrl: cfg.plane.baseUrl, workspaceSlug: cfg.plane.workspaceSlug, apiKey: '' });
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
      if (result.ok) {
        toast.success(t('settings.integrations.workTracking.toast.testOkCount', { count: result.count ?? 0 }));
      } else {
        toast.error(result.error ?? t('settings.integrations.workTracking.toast.testFailed'));
      }
    } finally {
      setTestingPlane(false);
    }
  }, [t]);

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
          <label className="space-y-1.5">
            <span className="typography-micro text-muted-foreground">{t('settings.integrations.workTracking.plane.workspaceSlug')}</span>
            <Input
              value={plane.workspaceSlug}
              onChange={(e) => setPlane({ ...plane, workspaceSlug: e.target.value })}
              placeholder="your-workspace"
            />
          </label>
          <label className="space-y-1.5 @lg:col-span-2">
            <span className="typography-micro text-muted-foreground">
              {t('settings.integrations.workTracking.plane.apiKey')}{' '}
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

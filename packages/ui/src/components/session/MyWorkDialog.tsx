import * as React from 'react';
import { Button } from '@/components/ui/button';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Icon } from "@/components/icon/Icon";
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { openExternalUrl } from '@/lib/url';
import { fetchMittrWork, type MittrWorkItem } from '@/lib/mittrWorkApi';

const NO_PHASE_KEY = '__no_phase__';

type ProjectGroup = {
  project: string;
  phases: { phase: string | null; items: MittrWorkItem[] }[];
};

const groupItems = (items: MittrWorkItem[]): ProjectGroup[] => {
  const byProject = new Map<string, Map<string, { phase: string | null; items: MittrWorkItem[] }>>();
  for (const item of items) {
    const projectKey = item.project || '';
    if (!byProject.has(projectKey)) {
      byProject.set(projectKey, new Map());
    }
    const phases = byProject.get(projectKey)!;
    const phaseKey = item.phase && item.phase.trim().length > 0 ? item.phase : NO_PHASE_KEY;
    if (!phases.has(phaseKey)) {
      phases.set(phaseKey, { phase: phaseKey === NO_PHASE_KEY ? null : item.phase, items: [] });
    }
    phases.get(phaseKey)!.items.push(item);
  }
  return Array.from(byProject.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([project, phases]) => ({
      project,
      phases: Array.from(phases.values()).sort((a, b) => (a.phase || '').localeCompare(b.phase || '')),
    }));
};

const handleOpenItem = (event: React.MouseEvent, url: string) => {
  if (!url) {
    return;
  }
  event.preventDefault();
  void openExternalUrl(url);
};

export function MyWorkDialog() {
  const { t } = useI18n();
  const open = useUIStore((state) => state.isMyWorkDialogOpen);
  const setOpen = useUIStore((state) => state.setMyWorkDialogOpen);
  const isMobile = useUIStore((state) => state.isMobile);

  const [items, setItems] = React.useState<MittrWorkItem[]>([]);
  const [configured, setConfigured] = React.useState(true);
  const [loading, setLoading] = React.useState(true);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const result = await fetchMittrWork();
      setConfigured(result.configured);
      setItems(result.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t('sessions.myWork.dialog.error'));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    void reload();
  }, [open, reload]);

  const groups = React.useMemo(() => groupItems(items), [items]);

  const body = (
    <div className="min-h-[280px] space-y-4">
      <div className="flex items-center justify-end">
        <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
          <Icon name="refresh" className={cn('h-4 w-4', loading && 'animate-spin')} />
          {t('sessions.myWork.dialog.actions.refresh')}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 typography-meta text-muted-foreground">
          <Icon name="loader-4" className="h-4 w-4 animate-spin" /> {t('sessions.myWork.dialog.loading')}
        </div>
      ) : errorMessage ? (
        <div
          className="flex items-start gap-2 rounded-md border p-3 typography-micro"
          style={{
            color: 'var(--status-error)',
            backgroundColor: 'var(--status-error-background)',
            borderColor: 'var(--status-error-border)',
          }}
        >
          <Icon name="error-warning" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{errorMessage}</span>
        </div>
      ) : !configured ? (
        <div className="rounded-lg border border-dashed border-border p-4 typography-meta text-muted-foreground">
          {t('sessions.myWork.dialog.notConnected')}
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-4 typography-meta text-muted-foreground">
          {t('sessions.myWork.dialog.empty')}
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <div key={group.project} className="space-y-3">
              <div className="typography-ui-header font-semibold text-foreground">{group.project}</div>
              {group.phases.map((phaseGroup) => (
                <div key={phaseGroup.phase ?? NO_PHASE_KEY} className="space-y-1.5">
                  <div className="typography-meta text-muted-foreground">
                    {phaseGroup.phase ?? t('sessions.myWork.dialog.noPhase')}
                  </div>
                  <div className="space-y-1.5">
                    {phaseGroup.items.map((item) => (
                      <a
                        key={item.id}
                        href={item.url}
                        onClick={(event) => handleOpenItem(event, item.url)}
                        className="block rounded-lg border border-border p-3 transition-colors hover:bg-interactive-hover/50"
                      >
                        <div className="typography-ui-label truncate font-medium text-foreground">
                          {item.title}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 typography-micro text-muted-foreground">
                          <span>{item.state}</span>
                          {item.priority ? (
                            <span>{t('sessions.myWork.dialog.row.priority', { priority: item.priority })}</span>
                          ) : null}
                          {item.due ? (
                            <span>{t('sessions.myWork.dialog.row.due', { due: item.due })}</span>
                          ) : null}
                        </div>
                      </a>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  if (isMobile) {
    return (
      <MobileOverlayPanel
        open={open}
        title={t('sessions.myWork.dialog.title')}
        onClose={() => setOpen(false)}
        contentMaxHeightClassName="max-h-[min(80vh,640px)]"
        renderHeader={(closeButton) => (
          <div className="flex flex-col gap-1 border-b border-border/40 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="typography-ui-label font-semibold text-foreground">{t('sessions.myWork.dialog.title')}</h2>
              {closeButton}
            </div>
            <p className="typography-micro text-muted-foreground">
              {t('sessions.myWork.dialog.description')}
            </p>
          </div>
        )}
      >
        {body}
      </MobileOverlayPanel>
    );
  }

  if (!open) {
    return null;
  }

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto w-full max-w-3xl">
          <p className="mb-4 typography-micro text-muted-foreground">
            {t('sessions.myWork.dialog.description')}
          </p>
          {body}
        </div>
      </div>
    </div>
  );
}

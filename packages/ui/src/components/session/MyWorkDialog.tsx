import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Icon } from "@/components/icon/Icon";
import { toast } from '@/components/ui';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { openExternalUrl } from '@/lib/url';
import { fetchMittrWork, type MittrWorkItem } from '@/lib/mittrWorkApi';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import * as sessionActions from '@/sync/session-actions';
import { useConfigStore } from '@/stores/useConfigStore';
import { parseModelIdentifier } from '@/lib/modelIdentifier';

const JIRA_KEY_PATTERN = /\/browse\/([A-Z][A-Z0-9]*-\d+)/;

/** `MRKB-2122` out of a Jira browse URL — items carry no separate key field. */
const jiraKeyOf = (item: MittrWorkItem): string | null => {
  const match = item.url.match(JIRA_KEY_PATTERN);
  return match ? match[1] : null;
};

type Source = 'jira' | 'plane';

const sourceOf = (item: MittrWorkItem): Source => (item.source === 'jira' ? 'jira' : 'plane');

/**
 * Lower rank surfaces first. States are free text from two different platforms with no shared
 * vocabulary, so this reads intent from a few common substrings rather than an exact match —
 * good enough to put "doing" ahead of "backlog" ahead of "done" without a lookup table neither
 * platform commits to keeping stable.
 */
const stateRank = (state: string): number => {
  const s = state.toLowerCase();
  if (/(progress|doing|active|review|test)/.test(s)) return 0;
  if (/(todo|backlog|plan|ready|open)/.test(s)) return 1;
  if (/(done|complete|closed|resolved)/.test(s)) return 3;
  if (/cancel/.test(s)) return 4;
  return 2;
};

type StateGroup = { state: string; items: MittrWorkItem[] };
type SourceGroup = { source: Source; items: MittrWorkItem[]; states: StateGroup[] };

const groupItems = (items: MittrWorkItem[]): SourceGroup[] => {
  const bySource = new Map<Source, Map<string, MittrWorkItem[]>>();
  for (const item of items) {
    const source = sourceOf(item);
    if (!bySource.has(source)) bySource.set(source, new Map());
    const byState = bySource.get(source)!;
    const stateKey = item.state || '';
    if (!byState.has(stateKey)) byState.set(stateKey, []);
    byState.get(stateKey)!.push(item);
  }
  const order: Source[] = ['jira', 'plane'];
  return order
    .filter((source) => bySource.has(source))
    .map((source) => {
      const byState = bySource.get(source)!;
      const states = Array.from(byState.entries())
        .map(([state, stateItems]) => ({ state, items: stateItems }))
        .sort((a, b) => stateRank(a.state) - stateRank(b.state) || a.state.localeCompare(b.state));
      return { source, items: states.flatMap((g) => g.items), states };
    });
};

const handleOpenItem = (event: React.MouseEvent, url: string) => {
  if (!url) return;
  event.preventDefault();
  void openExternalUrl(url);
};

export function MyWorkDialog() {
  const { t } = useI18n();
  const open = useUIStore((state) => state.isMyWorkDialogOpen);
  const setOpen = useUIStore((state) => state.setMyWorkDialogOpen);
  const isMobile = useUIStore((state) => state.isMobile);
  const activeProject = useProjectsStore((state) => state.getActiveProject());
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);

  const [items, setItems] = React.useState<MittrWorkItem[]>([]);
  const [configured, setConfigured] = React.useState(true);
  const [loading, setLoading] = React.useState(true);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [startingItemId, setStartingItemId] = React.useState<string | null>(null);

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
    if (!open) return;
    void reload();
  }, [open, reload]);

  React.useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => item.title.toLowerCase().includes(needle));
  }, [items, query]);

  const groups = React.useMemo(() => groupItems(filtered), [filtered]);

  const resolveDefaultAgentName = React.useCallback((): string | undefined => {
    const configState = useConfigStore.getState();
    const visibleAgents = configState.getVisibleAgents();
    if (configState.settingsDefaultAgent) {
      const settingsAgent = visibleAgents.find((a) => a.name === configState.settingsDefaultAgent);
      if (settingsAgent) return settingsAgent.name;
    }
    return visibleAgents.find((agent) => agent.name === 'build')?.name || visibleAgents[0]?.name;
  }, []);

  const resolveDefaultModelSelection = React.useCallback((): { providerID: string; modelID: string } | null => {
    const configState = useConfigStore.getState();
    const settingsDefaultModel = configState.settingsDefaultModel;
    if (!settingsDefaultModel) return null;
    const parsed = parseModelIdentifier(settingsDefaultModel);
    if (!parsed) return null;
    const { providerId: providerID, modelId: modelID } = parsed;
    if (!configState.getModelMetadata(providerID, modelID)) return null;
    return { providerID, modelID };
  }, []);

  const resolveDefaultVariant = React.useCallback((providerID: string, modelID: string): string | undefined => {
    const configState = useConfigStore.getState();
    const settingsDefaultVariant = configState.settingsDefaultVariant;
    const currentVariant = configState.currentProviderId === providerID && configState.currentModelId === modelID
      ? configState.currentVariant
      : undefined;
    const provider = configState.providers.find((p) => p.id === providerID);
    const model = provider?.models.find((m: Record<string, unknown>) => (m as { id?: string }).id === modelID) as
      | { variants?: Record<string, unknown> }
      | undefined;
    const variants = model?.variants;
    if (!variants) return settingsDefaultVariant || currentVariant || undefined;
    if (settingsDefaultVariant && Object.prototype.hasOwnProperty.call(variants, settingsDefaultVariant)) return settingsDefaultVariant;
    if (currentVariant && Object.prototype.hasOwnProperty.call(variants, currentVariant)) return currentVariant;
    return undefined;
  }, []);

  const goWork = React.useCallback(async (item: MittrWorkItem) => {
    if (startingItemId) return;
    const projectDirectory = activeProject?.path?.trim() || currentDirectory?.trim() || null;
    if (!projectDirectory) {
      toast.error(t('sessions.myWork.dialog.error.noActiveProject'));
      return;
    }
    setStartingItemId(item.id);
    try {
      const session = await sessionActions.createSession(item.title, projectDirectory, null);
      if (!session?.id) throw new Error('Failed to create session');
      const sessionId = session.id;

      try {
        useSessionUIStore.getState().initializeNewMittrCraftSession(sessionId, useConfigStore.getState().agents);
      } catch {
        // ignore
      }

      setOpen(false);

      const configState = useConfigStore.getState();
      const lastUsedProvider = useSelectionStore.getState().lastUsedProvider;
      const defaultModel = resolveDefaultModelSelection();
      const providerID = defaultModel?.providerID || configState.currentProviderId || lastUsedProvider?.providerID;
      const modelID = defaultModel?.modelID || configState.currentModelId || lastUsedProvider?.modelID;
      const agentName = resolveDefaultAgentName() || configState.currentAgentName || undefined;
      if (!providerID || !modelID) {
        toast.error(t('sessions.myWork.dialog.error.noModelSelected'));
        return;
      }
      const variant = resolveDefaultVariant(providerID, modelID);

      const key = jiraKeyOf(item);
      const prompt = key
        ? t('sessions.myWork.dialog.prompt.jira', { key, title: item.title, url: item.url })
        : t('sessions.myWork.dialog.prompt.plane', { title: item.title, url: item.url });

      void useSessionUIStore.getState().sendMessage(
        prompt,
        providerID,
        modelID,
        agentName,
        undefined,
        undefined,
        undefined,
        variant,
        undefined,
        { sessionId },
      ).catch((e) => {
        toast.error(t('sessions.myWork.dialog.toast.startFailed'), {
          description: e instanceof Error ? e.message : String(e),
        });
      });

      toast.success(t('sessions.myWork.dialog.toast.sessionCreated'));
    } catch (e) {
      toast.error(t('sessions.myWork.dialog.toast.startFailed'), {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setStartingItemId(null);
    }
  }, [activeProject?.path, currentDirectory, resolveDefaultAgentName, resolveDefaultModelSelection, resolveDefaultVariant, setOpen, startingItemId, t]);

  const sourceLabel = (source: Source) => (source === 'jira' ? t('sessions.myWork.dialog.source.jira') : t('sessions.myWork.dialog.source.plane'));
  const sourceIcon = (source: Source) => (source === 'jira' ? 'task' : 'stack');

  const body = (
    <div className="min-h-[280px] space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Icon name="search" className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('sessions.myWork.dialog.filter.placeholder')}
            className="h-8 pl-8 typography-small"
          />
        </div>
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
          {query.trim() ? t('sessions.myWork.dialog.filter.empty', { query: query.trim() }) : t('sessions.myWork.dialog.empty')}
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <div key={group.source} className="space-y-3">
              <div className="flex items-center gap-2">
                <Icon name={sourceIcon(group.source)} className="h-4 w-4 text-muted-foreground" />
                <span className="typography-ui-header font-semibold text-foreground">{sourceLabel(group.source)}</span>
                <span className="typography-micro text-muted-foreground">
                  {t('sessions.myWork.dialog.source.count', { count: group.items.length })}
                </span>
              </div>
              {group.states.map((stateGroup) => (
                <div key={stateGroup.state || '—'} className="space-y-1.5">
                  <div className="flex items-center gap-2 typography-meta text-muted-foreground">
                    <span>{stateGroup.state || '—'}</span>
                    <span className="rounded-full bg-muted px-1.5 py-0.5 typography-micro">{stateGroup.items.length}</span>
                  </div>
                  <div className="space-y-1.5">
                    {stateGroup.items.map((item) => (
                      <div
                        key={item.id}
                        className="group flex items-center gap-2 rounded-lg border border-border p-3 transition-colors hover:bg-interactive-hover/50"
                      >
                        <a
                          href={item.url}
                          onClick={(event) => handleOpenItem(event, item.url)}
                          className="min-w-0 flex-1"
                        >
                          <div className="typography-ui-label truncate font-medium text-foreground">
                            {item.title}
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 typography-micro text-muted-foreground">
                            {item.priority ? (
                              <span>{t('sessions.myWork.dialog.row.priority', { priority: item.priority })}</span>
                            ) : null}
                            {item.due ? (
                              <span>{t('sessions.myWork.dialog.row.due', { due: item.due })}</span>
                            ) : null}
                          </div>
                        </a>
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          disabled={startingItemId === item.id}
                          onClick={() => void goWork(item)}
                        >
                          {startingItemId === item.id ? (
                            <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Icon name="play" className="h-3.5 w-3.5" />
                          )}
                          {t('sessions.myWork.dialog.actions.goWork')}
                        </Button>
                      </div>
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

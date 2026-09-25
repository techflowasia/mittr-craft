import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon } from "@/components/icon/Icon";
import { toast } from '@/components/ui';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { cn, formatDirectoryName } from '@/lib/utils';
import { openExternalUrl } from '@/lib/url';
import { fetchMittrWork, type MittrWorkItem } from '@/lib/mittrWorkApi';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import * as sessionActions from '@/sync/session-actions';
import { useConfigStore } from '@/stores/useConfigStore';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import {
  countBySource,
  groupItems,
  groupStartsOpen,
  scopeBySource,
  stateRankColor,
  type Source,
  type SourceFilter,
} from './myWorkGrouping';

const SOURCE_FILTER_STORAGE_KEY = 'mittrcraft.myWork.source';
const GROUP_OPEN_STORAGE_PREFIX = 'mittrcraft.myWork.groupOpen.';

const readStorage = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStorage = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    return;
  }
};

const getStoredSourceFilter = (): SourceFilter => {
  const stored = readStorage(SOURCE_FILTER_STORAGE_KEY);
  return stored === 'jira' || stored === 'plane' ? stored : 'all';
};

const getStoredGroupOpen = (key: string, fallback: boolean): boolean => {
  const stored = readStorage(GROUP_OPEN_STORAGE_PREFIX + key);
  if (stored === '1') return true;
  if (stored === '0') return false;
  return fallback;
};

const JIRA_KEY_PATTERN = /\/browse\/([A-Z][A-Z0-9]*-\d+)/;

/** `MRKB-2122` out of a Jira browse URL — items carry no separate key field. */
const jiraKeyOf = (item: MittrWorkItem): string | null => {
  const match = item.url.match(JIRA_KEY_PATTERN);
  return match ? match[1] : null;
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
  const projects = useProjectsStore((state) => state.projects);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);

  const [items, setItems] = React.useState<MittrWorkItem[]>([]);
  const [configured, setConfigured] = React.useState(true);
  const [loading, setLoading] = React.useState(true);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [startingItemId, setStartingItemId] = React.useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = React.useState<SourceFilter>(() => getStoredSourceFilter());

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

  const selectSourceFilter = React.useCallback((value: SourceFilter) => {
    setSourceFilter(value);
    writeStorage(SOURCE_FILTER_STORAGE_KEY, value);
  }, []);

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => item.title.toLowerCase().includes(needle));
  }, [items, query]);

  const sourceCounts = React.useMemo(() => countBySource(filtered), [filtered]);

  const scopedItems = React.useMemo(() => scopeBySource(filtered, sourceFilter), [filtered, sourceFilter]);

  const groups = React.useMemo(() => groupItems(scopedItems), [scopedItems]);

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

  const goWork = React.useCallback(async (item: MittrWorkItem, projectDirectory: string) => {
    if (startingItemId) return;
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
  }, [resolveDefaultAgentName, resolveDefaultModelSelection, resolveDefaultVariant, setOpen, startingItemId, t]);

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

      <div className="flex items-center gap-1.5">
        <Button
          variant="chip"
          size="sm"
          aria-pressed={sourceFilter === 'all'}
          onClick={() => selectSourceFilter('all')}
        >
          {t('sessions.myWork.dialog.source.filter.all')} {sourceCounts.all}
        </Button>
        <Button
          variant="chip"
          size="sm"
          aria-pressed={sourceFilter === 'jira'}
          onClick={() => selectSourceFilter('jira')}
        >
          {t('sessions.myWork.dialog.source.jira')} {sourceCounts.jira}
        </Button>
        <Button
          variant="chip"
          size="sm"
          aria-pressed={sourceFilter === 'plane'}
          onClick={() => selectSourceFilter('plane')}
        >
          {t('sessions.myWork.dialog.source.plane')} {sourceCounts.plane}
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
            <div key={group.source} className="space-y-2">
              {sourceFilter === 'all' ? (
                <div className="flex items-center gap-2">
                  <Icon name={sourceIcon(group.source)} className="h-4 w-4 text-muted-foreground" />
                  <span className="typography-ui-header font-semibold text-foreground">{sourceLabel(group.source)}</span>
                  <span className="typography-micro text-muted-foreground">
                    {t('sessions.myWork.dialog.source.count', { count: group.items.length })}
                  </span>
                </div>
              ) : null}
              {group.states.map((stateGroup) => {
                const groupKey = `${group.source}:${stateGroup.state}`;
                const defaultOpen = groupStartsOpen(stateGroup.rank);
                const color = stateRankColor(stateGroup.rank);
                return (
                  <Collapsible
                    key={groupKey}
                    defaultOpen={getStoredGroupOpen(groupKey, defaultOpen)}
                    onOpenChange={(nextOpen: boolean) => writeStorage(GROUP_OPEN_STORAGE_PREFIX + groupKey, nextOpen ? '1' : '0')}
                  >
                    <CollapsibleTrigger className="group">
                      <span className="flex items-center gap-2 typography-meta text-muted-foreground">
                        <Icon name="arrow-right-s" className="h-3.5 w-3.5 shrink-0 transition-transform group-data-[panel-open]:rotate-90" />
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                        <span>{stateGroup.state || '—'}</span>
                        <span className="rounded-full bg-muted px-1.5 py-0.5 typography-micro">{stateGroup.items.length}</span>
                      </span>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="space-y-1 pt-1">
                        {stateGroup.items.map((item) => (
                          <div
                            key={item.id}
                            className="group flex items-center gap-2 rounded-md border-y border-r border-l-2 border-border py-1.5 pl-2.5 pr-2 transition-colors hover:bg-interactive-hover/50"
                            style={{ borderLeftColor: color }}
                          >
                            <a
                              href={item.url}
                              onClick={(event) => handleOpenItem(event, item.url)}
                              className="flex min-w-0 flex-1 items-baseline gap-2"
                            >
                              <span className="typography-ui-label min-w-0 truncate font-medium text-foreground" title={item.title}>
                                {item.title}
                              </span>
                              {item.priority || item.due ? (
                                <span className="flex shrink-0 items-center gap-2 typography-micro text-muted-foreground">
                                  {item.priority ? (
                                    <span>{t('sessions.myWork.dialog.row.priority', { priority: item.priority })}</span>
                                  ) : null}
                                  {item.due ? (
                                    <span>{t('sessions.myWork.dialog.row.due', { due: item.due })}</span>
                                  ) : null}
                                </span>
                              ) : null}
                            </a>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="shrink-0"
                                  disabled={startingItemId === item.id}
                                >
                                  {startingItemId === item.id ? (
                                    <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Icon name="play" className="h-3.5 w-3.5" />
                                  )}
                                  {t('sessions.myWork.dialog.actions.goWork')}
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-64">
                                <DropdownMenuLabel>{t('sessions.myWork.dialog.projectMenu.label')}</DropdownMenuLabel>
                                {projects.length === 0 ? (
                                  <DropdownMenuItem disabled>{t('sessions.myWork.dialog.projectMenu.empty')}</DropdownMenuItem>
                                ) : (
                                  projects.map((project) => {
                                    const name = project.label?.trim() || formatDirectoryName(project.path, homeDirectory || undefined);
                                    return (
                                      <DropdownMenuItem key={project.id} onClick={() => void goWork(item, project.path)}>
                                        <Icon name="folder" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                        <span className="min-w-0 truncate" title={project.path}>{name}</span>
                                      </DropdownMenuItem>
                                    );
                                  })
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
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

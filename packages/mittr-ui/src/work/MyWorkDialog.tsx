import React from 'react';

import { Icon } from '../../../ui/src/components/icon/Icon';
import { Button } from '../../../ui/src/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../../ui/src/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../ui/src/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../../../ui/src/components/ui/dropdown-menu';
import { Input } from '../../../ui/src/components/ui/input';
import { openExternalUrl } from '../../../ui/src/lib/url';
import { cn, formatDirectoryName } from '../../../ui/src/lib/utils';
import { useConfigStore } from '../../../ui/src/stores/useConfigStore';
import { useProjectsStore } from '../../../ui/src/stores/useProjectsStore';
import { useQuotaMe } from '../quota/quotaMeStore';
import { useMittrT } from '../strings/mittrT';
import { MY_WORK_LOADING, type MyWorkController, type MyWorkState } from './myWorkController';
import { mittrAvailable, mittrCatalogAliases, planGoWork, startGoWork, type GoWorkProject } from './goWork';
import { captureSendSelection } from './sendSelection';
import {
  cardKeyOf,
  chipPressed,
  displayLanes,
  groupItems,
  lanesOf,
  resolveFilter,
  scopeByLane,
  stateRankColor,
  type Lane,
  type LaneFilter,
  type LaneGroup,
  type WorkItem,
} from './workItems';
import { createWorkPrefs, type WorkPrefs } from './workPrefs';
import { sessionGoWorkDeps, useMyWorkController } from './workSession';

export type MyWorkDialogViewProps = {
  state: MyWorkState;
  filter: LaneFilter;
  prefs: Pick<WorkPrefs, 'groupOpen' | 'setGroupOpen'>;
  query: string;
  onQuery: (query: string) => void;
  onFilter: (filter: LaneFilter) => void;
  onRefresh: () => void;
  onOpenUrl: (url: string) => void;
  onGoWork?: (item: WorkItem, project: GoWorkProject) => void;
  startingItemId?: string | null;
  projects: readonly GoWorkProject[];
};

const NOTE_CLASS = 'rounded-lg border border-dashed border-border p-4 typography-meta text-muted-foreground';

type GoWorkMenuProps = {
  item: WorkItem;
  projects: readonly GoWorkProject[];
  onGoWork: (item: WorkItem, project: GoWorkProject) => void;
  starting: boolean;
};

export function GoWorkMenu({ item, projects, onGoWork, starting }: GoWorkMenuProps): React.ReactNode {
  const t = useMittrT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="shrink-0" disabled={starting}>
          <Icon name={starting ? 'loader-4' : 'play'} className={cn('h-3.5 w-3.5', starting && 'animate-spin')} />
          {t('mittr.work.actions.goWork')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>{t('mittr.work.projectMenu.label')}</DropdownMenuLabel>
        {projects.length === 0 ? (
          <DropdownMenuItem disabled>{t('mittr.work.projectMenu.empty')}</DropdownMenuItem>
        ) : (
          projects.map((project) => (
            <DropdownMenuItem key={project.id} onClick={() => onGoWork(item, project)}>
              <Icon name="folder" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate" title={project.path}>{project.label?.trim() || formatDirectoryName(project.path)}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type WorkRowProps = {
  item: WorkItem;
  color: string;
  onOpenUrl: (url: string) => void;
  goWork: React.ReactNode;
};

export function WorkRow({ item, color, onOpenUrl, goWork }: WorkRowProps): React.ReactNode {
  const t = useMittrT();
  const key = cardKeyOf(item);
  const url = item.url?.trim() ?? '';
  const content = (
    <>
      {key ? <span className="shrink-0 typography-micro font-mono text-muted-foreground">{key}</span> : null}
      <span className="typography-ui-label min-w-0 truncate font-medium text-foreground" title={item.title}>{item.title}</span>
      {item.state ? (
        <span className="shrink-0 rounded-full border px-1.5 typography-micro text-muted-foreground" style={{ borderColor: color }}>{item.state}</span>
      ) : null}
      {item.priority || item.due ? (
        <span className="flex shrink-0 items-center gap-2 typography-micro text-muted-foreground">
          {item.priority ? <span>{t('mittr.work.row.priority', { priority: item.priority })}</span> : null}
          {item.due ? <span>{t('mittr.work.row.due', { due: item.due })}</span> : null}
        </span>
      ) : null}
    </>
  );
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border-y border-r border-l-2 border-border py-1.5 pl-2.5 pr-2',
        url && 'transition-colors hover:bg-interactive-hover/50',
      )}
      style={{ borderLeftColor: color }}
    >
      {url ? (
        <button
          type="button"
          onClick={() => onOpenUrl(url)}
          className="flex min-w-0 flex-1 items-baseline gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {content}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-baseline gap-2">{content}</div>
      )}
      {goWork}
    </div>
  );
}

type WorkGroupProps = Pick<MyWorkDialogViewProps, 'prefs' | 'onOpenUrl' | 'onGoWork' | 'startingItemId' | 'projects'> & {
  group: LaneGroup;
  label: string | null;
};

type WorkStateCollapsibleProps = {
  initiallyOpen: boolean;
  onOpenChange: (open: boolean) => void;
  header: React.ReactNode;
  children: React.ReactNode;
};

function WorkStateCollapsible({ initiallyOpen, onOpenChange, header, children }: WorkStateCollapsibleProps): React.ReactNode {
  const [open, setOpen] = React.useState(initiallyOpen);
  const change = (next: boolean) => {
    setOpen(next);
    onOpenChange(next);
  };
  return (
    <Collapsible open={open} onOpenChange={change}>
      <CollapsibleTrigger>
        <span className="flex items-center gap-2 typography-meta text-muted-foreground">
          <Icon name="arrow-right-s" className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
          {header}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

function WorkGroup({ group, label, prefs, onOpenUrl, onGoWork, startingItemId, projects }: WorkGroupProps): React.ReactNode {
  const t = useMittrT();
  return (
    <div className="space-y-2">
      {label ? (
        <div className="flex items-center gap-2">
          <Icon name={group.source === 'jira' ? 'task' : 'stack'} className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="typography-ui-header font-semibold text-foreground">{label}</span>
          <span className="typography-micro text-muted-foreground">{t('mittr.work.source.count', { count: group.items.length })}</span>
        </div>
      ) : null}
      {group.states.map((stateGroup) => {
        const groupKey = `${group.key}:${stateGroup.state}`;
        const color = stateRankColor(stateGroup.rank);
        return (
          <WorkStateCollapsible
            key={groupKey}
            initiallyOpen={prefs.groupOpen(groupKey, stateGroup.rank)}
            onOpenChange={(open) => prefs.setGroupOpen(groupKey, open)}
            header={(
              <>
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                <span>{stateGroup.state || '—'}</span>
                <span className="rounded-full bg-muted px-1.5 py-0.5 typography-micro">{stateGroup.items.length}</span>
              </>
            )}
          >
            <div className="space-y-1 pt-1">
              {stateGroup.items.map((item) => (
                <WorkRow
                  key={item.id}
                  item={item}
                  color={color}
                  onOpenUrl={onOpenUrl}
                  goWork={onGoWork ? <GoWorkMenu item={item} projects={projects} onGoWork={onGoWork} starting={startingItemId === item.id} /> : null}
                />
              ))}
            </div>
          </WorkStateCollapsible>
        );
      })}
    </div>
  );
}

export function MyWorkDialogView({ state, filter, prefs, query, onQuery, onFilter, onRefresh, onOpenUrl, onGoWork, startingItemId = null, projects }: MyWorkDialogViewProps): React.ReactNode {
  const t = useMittrT();
  const loading = state.status === 'loading';
  const needle = query.trim().toLowerCase();
  const filtered = needle ? state.items.filter((item) => item.title.toLowerCase().includes(needle)) : state.items;
  const chips = displayLanes(state.items);
  const resolved = resolveFilter(filter, state.items);
  const groups = groupItems(scopeByLane(filtered, resolved));
  const namedGroups = lanesOf(state.items).filter((lane) => lane.source === 'plane').length > 1;

  const sourceLabel = (lane: Pick<Lane, 'source' | 'workspace'>, named: boolean): string => {
    if (lane.source === 'jira') return t('mittr.work.source.jira');
    return named && lane.workspace ? lane.workspace : t('mittr.work.source.plane');
  };
  const chipCount = (lane: Lane): number => (needle ? scopeByLane(filtered, lane.key).length : lane.count);

  const body = (): React.ReactNode => {
    if (loading) {
      return (
        <div className="flex items-center gap-2 typography-meta text-muted-foreground">
          <Icon name="loader-4" className="h-4 w-4 animate-spin" /> {t('mittr.work.loading')}
        </div>
      );
    }
    if (state.status === 'error') {
      return (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-3 typography-micro text-[var(--status-error-text)]"
        >
          <Icon name="error-warning" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{state.error || t('mittr.work.error')}</span>
        </div>
      );
    }
    if (state.status === 'not-connected') return <div className={NOTE_CLASS}>{t('mittr.work.notConnected')}</div>;
    if (groups.length === 0) {
      return <div className={NOTE_CLASS}>{needle ? t('mittr.work.filter.empty', { query: query.trim() }) : t('mittr.work.empty')}</div>;
    }
    return (
      <div className="space-y-6">
        {groups.map((group) => (
          <WorkGroup
            key={group.key}
            group={group}
            label={groups.length > 1 ? sourceLabel(group, namedGroups) : null}
            prefs={prefs}
            onOpenUrl={onOpenUrl}
            onGoWork={onGoWork}
            startingItemId={startingItemId}
            projects={projects}
          />
        ))}
      </div>
    );
  };

  return (
    <div className="min-h-[280px] space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Icon name="search" className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder={t('mittr.work.filter.placeholder')}
            aria-label={t('mittr.work.filter.label')}
            className="h-8 pl-8 typography-small"
          />
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          <Icon name="refresh" className={cn('h-4 w-4', loading && 'animate-spin')} />
          {t('mittr.work.actions.refresh')}
        </Button>
      </div>

      {state.status === 'ready' ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="chip" size="sm" aria-pressed={resolved === 'all'} onClick={() => onFilter('all')}>
            {t('mittr.work.source.filter.all')} {filtered.length}
          </Button>
          {chips.map((lane) => {
            const named = lane.workspace !== null;
            const label = sourceLabel(lane, named);
            const accessible = named && lane.workspace ? t('mittr.work.source.planeWorkspace', { workspace: lane.workspace }) : label;
            const count = chipCount(lane);
            return (
              <Button
                key={lane.key}
                variant="chip"
                size="sm"
                aria-pressed={chipPressed(lane.key, resolved, chips)}
                aria-label={`${accessible} ${count}`}
                onClick={() => onFilter(lane.key)}
              >
                {named ? <Icon name="stack" className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                {label} {count}
              </Button>
            );
          })}
        </div>
      ) : null}

      {body()}
    </div>
  );
}

const browserStorage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const subscribeNothing = (): (() => void) => () => {};

type GoWorkBinding = { startingItemId: string | null; goWork: (item: WorkItem, project: GoWorkProject) => void };

function useGoWork(onClose: () => void, controller: MyWorkController | null): GoWorkBinding {
  const quota = useQuotaMe(true);
  const agentStatus = quota.status === 'ok' ? quota.quota.agentStatus : null;
  const [startingItemId, setStartingItemId] = React.useState<string | null>(null);
  const running = React.useRef(false);
  const goWork = (item: WorkItem, project: GoWorkProject) => {
    const plan = () => {
      const selection = captureSendSelection();
      const available = mittrAvailable(selection, mittrCatalogAliases(useConfigStore.getState().providers), agentStatus);
      return planGoWork({ item, project, selection, available, listIsForCurrentAccount: controller?.listIsForCurrentAccount() ?? false });
    };
    void startGoWork(running, setStartingItemId, item.id, plan, sessionGoWorkDeps(onClose, () => { void controller?.refresh(); }));
  };
  return { startingItemId, goWork };
}

function MyWorkPanel({ onClose }: { onClose: () => void }): React.ReactNode {
  const t = useMittrT();
  const controller = useMyWorkController();
  const { startingItemId, goWork } = useGoWork(onClose, controller);
  const state = React.useSyncExternalStore(
    controller ? controller.subscribe : subscribeNothing,
    () => (controller ? controller.state() : MY_WORK_LOADING),
    () => MY_WORK_LOADING,
  );
  const [prefs] = React.useState(() => createWorkPrefs(browserStorage()));
  const [filter, setFilter] = React.useState<LaneFilter>(() => prefs.sourceFilter());
  const [query, setQuery] = React.useState('');
  const projects = useProjectsStore((store) => store.projects);

  const selectFilter = (next: LaneFilter) => {
    setFilter(next);
    prefs.setSourceFilter(next);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('mittr.work.title')}</DialogTitle>
        <DialogDescription>{t('mittr.work.description')}</DialogDescription>
      </DialogHeader>
      <MyWorkDialogView
        state={state}
        filter={filter}
        prefs={prefs}
        query={query}
        onQuery={setQuery}
        onFilter={selectFilter}
        onRefresh={() => { void controller?.refresh(); }}
        onOpenUrl={(url) => { void openExternalUrl(url); }}
        onGoWork={goWork}
        startingItemId={startingItemId}
        projects={projects}
      />
    </>
  );
}

export type MyWorkDialogProps = { open: boolean; onOpenChange: (open: boolean) => void };

export function MyWorkDialog({ open, onOpenChange }: MyWorkDialogProps): React.ReactNode {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogContent className="max-w-3xl">
        <MyWorkPanel onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

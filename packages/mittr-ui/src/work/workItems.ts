export type WorkItem = {
  id: string;
  title: string;
  project: string;
  phase: string | null;
  state: string;
  priority: string | null;
  due: string | null;
  estimate: string | null;
  url: string;
  updatedAt: string;
  source?: 'plane' | 'jira';
  key?: string | null;
  workspace?: string | null;
};

export type Source = 'jira' | 'plane';
export type LaneFilter = string;

export const sourceOf = (item: WorkItem): Source => (item.source === 'jira' ? 'jira' : 'plane');

const workspaceOf = (item: WorkItem): string | null => {
  if (sourceOf(item) !== 'plane') return null;
  const workspace = item.workspace?.trim();
  return workspace ? workspace : null;
};

export const laneOf = (item: WorkItem): string => {
  const workspace = workspaceOf(item);
  return workspace ? `plane:${workspace}` : sourceOf(item);
};

export type Lane = { key: string; source: Source; workspace: string | null; count: number };

const laneOrder = (a: Lane, b: Lane): number => {
  if (a.source !== b.source) return a.source === 'jira' ? -1 : 1;
  return (a.workspace ?? '').localeCompare(b.workspace ?? '');
};

export const lanesOf = (items: WorkItem[]): Lane[] => {
  const lanes = new Map<string, Lane>();
  for (const item of items) {
    const key = laneOf(item);
    const lane = lanes.get(key) ?? { key, source: sourceOf(item), workspace: workspaceOf(item), count: 0 };
    lane.count += 1;
    lanes.set(key, lane);
  }
  return Array.from(lanes.values()).sort(laneOrder);
};

export const displayLanes = (items: WorkItem[]): Lane[] => {
  const lanes = lanesOf(items);
  const planeLanes = lanes.filter((lane) => lane.source === 'plane');
  if (planeLanes.length === 0) return lanes;
  const planeCount = planeLanes.reduce((total, lane) => total + lane.count, 0);
  const workspaces = new Set(planeLanes.map((lane) => lane.workspace).filter((workspace) => workspace !== null));
  if (workspaces.size > 1) {
    return lanes.map((lane) => (lane.key === 'plane' ? { ...lane, count: planeCount } : lane));
  }
  const merged: Lane = { key: 'plane', source: 'plane', workspace: null, count: planeCount };
  return lanes.flatMap((lane) => (lane.source !== 'plane' ? [lane] : lane === planeLanes[0] ? [merged] : []));
};

export const resolveFilter = (saved: string, items: WorkItem[]): string => {
  if (saved === 'all') return saved;
  if (saved === 'plane') return items.some((item) => sourceOf(item) === 'plane') ? saved : 'all';
  return lanesOf(items).some((lane) => lane.key === saved) ? saved : 'all';
};

export const chipPressed = (chipKey: string, filter: string): boolean =>
  chipKey === 'plane' ? filter === 'plane' || filter.startsWith('plane:') : chipKey === filter;

export const stateRank = (state: string): number => {
  const s = state.toLowerCase();
  if (/(progress|doing|active|review|test)/.test(s)) return 0;
  if (/(todo|backlog|plan|ready|open)/.test(s)) return 1;
  if (/(done|complete|closed|resolved)/.test(s)) return 3;
  if (/cancel/.test(s)) return 4;
  return 2;
};

const STATE_RANK_COLOR: Record<number, string> = {
  0: 'var(--status-info)',
  1: 'var(--status-warning)',
  2: 'var(--border)',
  3: 'var(--status-success)',
  4: 'var(--status-error)',
};

export const stateRankColor = (rank: number): string => STATE_RANK_COLOR[rank] ?? STATE_RANK_COLOR[2];

export const groupStartsOpen = (rank: number): boolean => rank !== 3 && rank !== 4;

export type StateGroup = { state: string; items: WorkItem[]; rank: number };
export type LaneGroup = { key: string; source: Source; workspace: string | null; items: WorkItem[]; states: StateGroup[] };

export const groupItems = (items: WorkItem[]): LaneGroup[] =>
  lanesOf(items).map((lane) => {
    const byState = new Map<string, WorkItem[]>();
    for (const item of items) {
      if (laneOf(item) !== lane.key) continue;
      const stateKey = item.state || '';
      const bucket = byState.get(stateKey) ?? [];
      bucket.push(item);
      byState.set(stateKey, bucket);
    }
    const states = Array.from(byState.entries())
      .map(([state, stateItems]) => ({ state, items: stateItems, rank: stateRank(state) }))
      .sort((a, b) => a.rank - b.rank || a.state.localeCompare(b.state));
    return { key: lane.key, source: lane.source, workspace: lane.workspace, items: states.flatMap((g) => g.items), states };
  });

export const countByLane = (items: WorkItem[]): Record<string, number> => {
  const counts: Record<string, number> = { all: items.length };
  for (const lane of lanesOf(items)) counts[lane.key] = lane.count;
  return counts;
};

export const scopeByLane = (items: WorkItem[], filter: LaneFilter): WorkItem[] => {
  if (filter === 'all') return items;
  if (filter === 'jira' || filter === 'plane') return items.filter((item) => sourceOf(item) === filter);
  return items.filter((item) => laneOf(item) === filter);
};

const JIRA_KEY_PATTERN = /\/browse\/([A-Z][A-Z0-9]*-\d+)/;

export const cardKeyOf = (item: WorkItem): string | null => {
  const sent = item.key?.trim();
  if (sent) return sent;
  if (sourceOf(item) !== 'jira') return null;
  const match = item.url?.match(JIRA_KEY_PATTERN);
  return match ? match[1] : null;
};

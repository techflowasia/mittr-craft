import type { MittrWorkItem } from '@/lib/mittrWorkApi';

export type Source = 'jira' | 'plane';
export type LaneFilter = string;

export const sourceOf = (item: MittrWorkItem): Source => (item.source === 'jira' ? 'jira' : 'plane');

const workspaceOf = (item: MittrWorkItem): string | null => {
  if (sourceOf(item) !== 'plane') return null;
  const workspace = item.workspace?.trim();
  return workspace ? workspace : null;
};

export const laneOf = (item: MittrWorkItem): string => {
  const workspace = workspaceOf(item);
  return workspace ? `plane:${workspace}` : sourceOf(item);
};

export type Lane = { key: string; source: Source; workspace: string | null; count: number };

const laneOrder = (a: Lane, b: Lane): number => {
  if (a.source !== b.source) return a.source === 'jira' ? -1 : 1;
  return (a.workspace ?? '').localeCompare(b.workspace ?? '');
};

export const lanesOf = (items: MittrWorkItem[]): Lane[] => {
  const lanes = new Map<string, Lane>();
  for (const item of items) {
    const key = laneOf(item);
    const lane = lanes.get(key) ?? { key, source: sourceOf(item), workspace: workspaceOf(item), count: 0 };
    lane.count += 1;
    lanes.set(key, lane);
  }
  return Array.from(lanes.values()).sort(laneOrder);
};

/**
 * Lower rank surfaces first. States are free text from two different platforms with no shared
 * vocabulary, so this reads intent from a few common substrings rather than an exact match —
 * good enough to put "doing" ahead of "backlog" ahead of "done" without a lookup table neither
 * platform commits to keeping stable.
 */
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

export type StateGroup = { state: string; items: MittrWorkItem[]; rank: number };
export type LaneGroup = { key: string; source: Source; workspace: string | null; items: MittrWorkItem[]; states: StateGroup[] };

export const groupItems = (items: MittrWorkItem[]): LaneGroup[] =>
  lanesOf(items).map((lane) => {
    const byState = new Map<string, MittrWorkItem[]>();
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

export const countByLane = (items: MittrWorkItem[]): Record<string, number> => {
  const counts: Record<string, number> = { all: items.length };
  for (const lane of lanesOf(items)) counts[lane.key] = lane.count;
  return counts;
};

export const scopeByLane = (items: MittrWorkItem[], filter: LaneFilter): MittrWorkItem[] => {
  if (filter === 'all') return items;
  if (filter === 'jira' || filter === 'plane') return items.filter((item) => sourceOf(item) === filter);
  return items.filter((item) => laneOf(item) === filter);
};

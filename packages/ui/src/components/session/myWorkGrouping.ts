import type { MittrWorkItem } from '@/lib/mittrWorkApi';

export type Source = 'jira' | 'plane';
export type SourceFilter = 'all' | Source;

export const sourceOf = (item: MittrWorkItem): Source => (item.source === 'jira' ? 'jira' : 'plane');

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
export type SourceGroup = { source: Source; items: MittrWorkItem[]; states: StateGroup[] };

export const groupItems = (items: MittrWorkItem[]): SourceGroup[] => {
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
        .map(([state, stateItems]) => ({ state, items: stateItems, rank: stateRank(state) }))
        .sort((a, b) => a.rank - b.rank || a.state.localeCompare(b.state));
      return { source, items: states.flatMap((g) => g.items), states };
    });
};

export const countBySource = (items: MittrWorkItem[]): Record<SourceFilter, number> => {
  let jira = 0;
  for (const item of items) if (sourceOf(item) === 'jira') jira += 1;
  return { all: items.length, jira, plane: items.length - jira };
};

export const scopeBySource = (items: MittrWorkItem[], filter: SourceFilter): MittrWorkItem[] => (
  filter === 'all' ? items : items.filter((item) => sourceOf(item) === filter)
);

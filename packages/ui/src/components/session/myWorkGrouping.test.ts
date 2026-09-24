import { describe, expect, test } from 'bun:test';

import type { MittrWorkItem } from '@/lib/mittrWorkApi';
import { countBySource, groupItems, groupStartsOpen, scopeBySource, stateRankColor } from './myWorkGrouping';

const item = (id: string, source: 'jira' | 'plane', state: string): MittrWorkItem => ({
  id,
  title: id,
  project: 'P',
  phase: null,
  state,
  priority: null,
  due: null,
  estimate: null,
  url: `https://example.test/${id}`,
  updatedAt: '2026-09-24T00:00:00Z',
  source,
});

const items = [
  item('j1', 'jira', 'In Progress'),
  item('j2', 'jira', 'Done'),
  item('j3', 'jira', 'Readytotest'),
  item('p1', 'plane', 'Todo'),
  item('p2', 'plane', 'Cancelled'),
];

describe('my work grouping', () => {
  test('counts items per source and in total', () => {
    expect(countBySource(items)).toEqual({ all: 5, jira: 3, plane: 2 });
  });

  test('shows only the chosen source, or everything for all', () => {
    expect(scopeBySource(items, 'plane').map((entry) => entry.id)).toEqual(['p1', 'p2']);
    expect(scopeBySource(items, 'all')).toHaveLength(5);
  });

  test('orders states by how active they are and keeps the rank on each group', () => {
    const [jira] = groupItems(items);
    expect(jira.states.map((group) => [group.state, group.rank])).toEqual([
      ['In Progress', 0],
      ['Readytotest', 0],
      ['Done', 3],
    ]);
  });

  test('starts done and cancelled groups closed and the rest open', () => {
    expect([0, 1, 2, 3, 4].map(groupStartsOpen)).toEqual([true, true, true, false, false]);
  });

  test('colors each rank with an existing status token, never a raw color', () => {
    expect([0, 1, 2, 3, 4].map(stateRankColor)).toEqual([
      'var(--status-info)',
      'var(--status-warning)',
      'var(--border)',
      'var(--status-success)',
      'var(--status-error)',
    ]);
  });
});

import { describe, expect, test } from 'bun:test';

import type { MittrWorkItem } from '@/lib/mittrWorkApi';
import { countByLane, groupItems, groupStartsOpen, lanesOf, scopeByLane, stateRankColor } from './myWorkGrouping';

const item = (id: string, source: 'jira' | 'plane', state: string, workspace?: string): MittrWorkItem => ({
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
  ...(workspace ? { workspace } : {}),
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
    expect(countByLane(items)).toEqual({ all: 5, jira: 3, plane: 2 });
  });

  test('shows only the chosen source, or everything for all', () => {
    expect(scopeByLane(items, 'plane').map((entry) => entry.id)).toEqual(['p1', 'p2']);
    expect(scopeByLane(items, 'all')).toHaveLength(5);
  });

  const spread = [
    item('j1', 'jira', 'In Progress'),
    item('a1', 'plane', 'Todo', 'techflow'),
    item('b1', 'plane', 'In Progress', 'techflowgg'),
    item('a2', 'plane', 'Done', 'techflow'),
  ];

  test('gives every Plane workspace a lane of its own, after Jira', () => {
    expect(lanesOf(spread).map((lane) => [lane.key, lane.workspace, lane.count])).toEqual([
      ['jira', null, 1],
      ['plane:techflow', 'techflow', 2],
      ['plane:techflowgg', 'techflowgg', 1],
    ]);
    expect(countByLane(spread)).toEqual({ all: 4, jira: 1, 'plane:techflow': 2, 'plane:techflowgg': 1 });
  });

  test('scopes to one workspace, and a saved plain Plane filter still means every workspace', () => {
    expect(scopeByLane(spread, 'plane:techflowgg').map((entry) => entry.id)).toEqual(['b1']);
    expect(scopeByLane(spread, 'plane').map((entry) => entry.id)).toEqual(['a1', 'b1', 'a2']);
  });

  test('groups each workspace on its own with its states inside', () => {
    expect(groupItems(spread).map((group) => [group.key, group.workspace, group.items.map((entry) => entry.id)])).toEqual([
      ['jira', null, ['j1']],
      ['plane:techflow', 'techflow', ['a1', 'a2']],
      ['plane:techflowgg', 'techflowgg', ['b1']],
    ]);
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

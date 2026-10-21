import { describe, expect, test } from 'bun:test';

import {
  cardKeyOf,
  countByLane,
  chipPressed,
  displayLanes,
  groupItems,
  groupStartsOpen,
  lanesOf,
  resolveFilter,
  scopeByLane,
  stateRankColor,
  type WorkItem,
} from './workItems';

const item = (id: string, source: 'jira' | 'plane', state: string, workspace?: string): WorkItem => ({
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

describe('my work Plane workspaces', () => {
  const two = [
    item('j1', 'jira', 'In Progress'),
    item('t1', 'plane', 'Todo', 'techflow'),
    item('m1', 'plane', 'Todo', 'mittr'),
    item('t2', 'plane', 'Done', 'techflow'),
  ];

  test('two Plane workspaces give two lanes', () => {
    expect(displayLanes(two).map((lane) => lane.key)).toEqual(['jira', 'plane:mittr', 'plane:techflow']);
  });

  test('a single Plane workspace shows one Plane chip', () => {
    const one = [item('j1', 'jira', 'Todo'), item('t1', 'plane', 'Todo', 'techflow'), item('t2', 'plane', 'Done', 'techflow')];
    const lanes = displayLanes(one);
    expect(lanes.map((lane) => [lane.key, lane.count])).toEqual([
      ['jira', 1],
      ['plane', 2],
    ]);
    expect(groupItems(one).map((group) => group.key)).toEqual(['jira', 'plane:techflow']);
  });

  test('Plane items with no workspace and one named workspace share one chip', () => {
    const mixed = [item('p1', 'plane', 'Todo'), item('t1', 'plane', 'Todo', 'techflow')];
    expect(displayLanes(mixed).map((lane) => [lane.key, lane.count])).toEqual([['plane', 2]]);
  });

  test('no Plane items give no Plane chip', () => {
    expect(displayLanes([item('j1', 'jira', 'Todo')]).map((lane) => lane.key)).toEqual(['jira']);
    expect(displayLanes([])).toEqual([]);
  });

  test('a saved plane filter still means every workspace', () => {
    expect(scopeByLane(two, 'plane').map((entry) => entry.id)).toEqual(['t1', 'm1', 't2']);
  });

  test('every chip counts what its filter scopes, including a leftover Plane chip', () => {
    const mixed = [...two, item('p1', 'plane', 'Todo')];
    const lanes = displayLanes(mixed);
    expect(lanes.map((lane) => [lane.key, lane.count])).toEqual([
      ['jira', 1],
      ['plane', 4],
      ['plane:mittr', 1],
      ['plane:techflow', 2],
    ]);
    for (const lane of lanes) expect(lane.count).toBe(scopeByLane(mixed, lane.key).length);
    const collapsed = [item('p1', 'plane', 'Todo'), item('t1', 'plane', 'Todo', 'techflow')];
    for (const lane of displayLanes(collapsed)) expect(lane.count).toBe(scopeByLane(collapsed, lane.key).length);
  });

  test('a stale, junk or valid saved filter resolves against the items', () => {
    expect(resolveFilter('all', two)).toBe('all');
    expect(resolveFilter('jira', two)).toBe('jira');
    expect(resolveFilter('plane', two)).toBe('plane');
    expect(resolveFilter('plane:mittr', two)).toBe('plane:mittr');
    expect(resolveFilter('plane:gone', two)).toBe('all');
    expect(resolveFilter('junk', two)).toBe('all');
    expect(resolveFilter('', two)).toBe('all');
    expect(resolveFilter('plane', [item('j1', 'jira', 'Todo')])).toBe('all');
    expect(resolveFilter('jira', [item('p1', 'plane', 'Todo')])).toBe('all');
  });

  test('the Plane chip is pressed for plane and for a workspace with no chip of its own', () => {
    const collapsed = displayLanes([item('j1', 'jira', 'Todo'), item('t1', 'plane', 'Todo', 'techflow')]);
    expect(chipPressed('plane', 'plane', collapsed)).toBe(true);
    expect(chipPressed('plane', 'plane:techflow', collapsed)).toBe(true);
    expect(chipPressed('plane', 'jira', collapsed)).toBe(false);
    expect(chipPressed('plane', 'all', collapsed)).toBe(false);
    expect(chipPressed('jira', 'jira', collapsed)).toBe(true);
    expect(chipPressed('jira', 'plane', collapsed)).toBe(false);
  });

  test('with several workspaces and a leftover Plane chip exactly one chip is pressed', () => {
    const mixed = [item('j1', 'jira', 'Todo'), item('t1', 'plane', 'Todo', 'techflow'), item('m1', 'plane', 'Todo', 'mittr'), item('p1', 'plane', 'Todo')];
    const lanes = displayLanes(mixed);
    expect(lanes.map((lane) => lane.key)).toEqual(['jira', 'plane', 'plane:mittr', 'plane:techflow']);
    for (const filter of ['all', 'jira', 'plane', 'plane:mittr', 'plane:techflow']) {
      const pressed = lanes.filter((lane) => chipPressed(lane.key, filter, lanes)).map((lane) => lane.key);
      expect(pressed).toEqual(filter === 'all' ? [] : [filter]);
    }
  });
});

describe('my work card keys', () => {
  test('an item without key shows the Jira browse key or nothing', () => {
    const jira = { ...item('j1', 'jira', 'Todo'), key: null, url: 'https://x.atlassian.net/browse/MRKB-2122' };
    expect(cardKeyOf(jira)).toBe('MRKB-2122');
    expect(cardKeyOf({ ...item('p1', 'plane', 'Todo'), key: null })).toBeNull();
  });

  test('a keyless Plane item never reads a key from its URL', () => {
    const plane = { ...item('p1', 'plane', 'Todo'), key: null, url: 'https://plane.example.test/techflow/browse/PROJ-1/' };
    expect(cardKeyOf(plane)).toBeNull();
  });

  test('a Jira item without a URL has no key', () => {
    const jira = { ...item('j1', 'jira', 'Todo'), key: null } as Partial<WorkItem>;
    delete jira.url;
    expect(cardKeyOf(jira as WorkItem)).toBeNull();
  });

  test('the key the platform sends wins over the URL', () => {
    const jira = { ...item('j1', 'jira', 'Todo'), key: ' MITRAI-12 ', url: 'https://x.atlassian.net/browse/MRKB-1' };
    expect(cardKeyOf(jira)).toBe('MITRAI-12');
  });

  test('a blank key falls back to the URL', () => {
    const jira = { ...item('j1', 'jira', 'Todo'), key: '  ', url: 'https://x.atlassian.net/browse/MRKB-7' };
    expect(cardKeyOf(jira)).toBe('MRKB-7');
  });
});

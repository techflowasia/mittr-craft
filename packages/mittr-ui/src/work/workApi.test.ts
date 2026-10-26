import { describe, expect, test } from 'bun:test';
import type { JsonValue } from '@openchamber/sdk';

import { mittrT } from '../strings/mittrT';
import { fetchMyWork, WORK_ENDPOINT, type WorkResponse } from './workApi';

const ITEM = {
  id: 'w-1',
  title: 'Fix login',
  project: 'MRKB',
  phase: null,
  state: 'In Progress',
  priority: 'High',
  due: '2026-10-30',
  estimate: null,
  url: 'https://x.atlassian.net/browse/MRKB-2122',
  updatedAt: '2026-10-20T00:00:00Z',
  source: 'jira',
  key: 'MRKB-2122',
};

const reply = (status: number, body: JsonValue | Promise<JsonValue>): WorkResponse => ({
  ok: status >= 200 && status < 300,
  json: () => Promise.resolve(body),
});

const fetching = (response: WorkResponse) => {
  const paths: string[] = [];
  const fetchImpl = (path: string) => {
    paths.push(path);
    return Promise.resolve(response);
  };
  return { paths, fetchImpl };
};

describe('fetchMyWork', () => {
  test('a reply names the items and the account it was read for', async () => {
    const { paths, fetchImpl } = fetching(reply(200, { configured: true, items: [ITEM], userId: 'u-a' }));
    const result = await fetchMyWork(fetchImpl);
    expect(paths).toEqual([WORK_ENDPOINT]);
    expect(result.configured).toBe(true);
    expect(result.userId).toBe('u-a');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].key).toBe('MRKB-2122');
    expect(result.items[0].title).toBe('Fix login');
  });

  test('a server that is not connected says so with no items', async () => {
    const { fetchImpl } = fetching(reply(200, { configured: false, items: [], userId: null }));
    expect(await fetchMyWork(fetchImpl)).toEqual({ configured: false, items: [], userId: null });
  });

  test('an item the window cannot read is left out and the others stay', async () => {
    const { fetchImpl } = fetching(reply(200, { configured: true, items: [ITEM, { title: 'no id' }, 'junk'], userId: 'u-a' }));
    const result = await fetchMyWork(fetchImpl);
    expect(result.items.map((item) => item.id)).toEqual(['w-1']);
  });

  test('a field an older platform does not send reads as empty', async () => {
    const { fetchImpl } = fetching(reply(200, { configured: true, items: [{ id: 'p-1', title: 'Plan', state: 'Todo', url: 'https://plane.test/p-1' }], userId: 'u-a' }));
    const [item] = (await fetchMyWork(fetchImpl)).items;
    expect(item).toMatchObject({ id: 'p-1', title: 'Plan', state: 'Todo', priority: null, due: null, phase: null, estimate: null, project: '' });
  });

  test('a refusal carries the server\'s own text', async () => {
    const { fetchImpl } = fetching(reply(403, { error: 'Not authorized to read work items' }));
    await expect(fetchMyWork(fetchImpl)).rejects.toThrow('Not authorized to read work items');
  });

  test('a failure without text, a broken reply or no connection reads as the plain failure text', async () => {
    const plain = mittrT('mittr.work.error');
    expect(plain).toBe('Failed to load work items');
    await expect(fetchMyWork(fetching(reply(500, {})).fetchImpl)).rejects.toThrow(plain);
    await expect(fetchMyWork(fetching(reply(500, { error: '  ' })).fetchImpl)).rejects.toThrow(plain);
    await expect(fetchMyWork(fetching(reply(200, Promise.reject(new SyntaxError('bad json')))).fetchImpl)).rejects.toThrow(plain);
    await expect(fetchMyWork(fetching(reply(200, { items: 'none' })).fetchImpl)).rejects.toThrow(plain);
    await expect(fetchMyWork(() => Promise.reject(new TypeError('Failed to fetch')))).rejects.toThrow(plain);
  });
});

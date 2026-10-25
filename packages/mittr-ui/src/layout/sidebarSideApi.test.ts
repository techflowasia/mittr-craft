import type { JsonValue } from '@openchamber/sdk';
import { describe, expect, test } from 'bun:test';

import { mittrT } from '../strings/mittrT';
import { createSidebarSideApi, SidebarSideRequestError, type SidebarSideFetch } from './sidebarSideApi';

type Call = { path: string; method: string; body: JsonValue | null };

const respond = (status: number, body: JsonValue | 'not json') => {
  const calls: Call[] = [];
  const fetchImpl: SidebarSideFetch = async (path, init) => {
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === 'not json') throw new SyntaxError('bad json');
        return body;
      },
    };
  };
  return { api: createSidebarSideApi(fetchImpl), calls };
};

const refusedWith = async (work: Promise<object>, message: string, status: number | null) => {
  const error = await work.then(() => null, (caught: Error) => caught);
  expect(error).toBeInstanceOf(SidebarSideRequestError);
  expect(error?.message).toBe(message);
  expect(error instanceof SidebarSideRequestError ? error.status : undefined).toBe(status);
};

describe('MittrCraft sidebar side API', () => {
  test('the side is read from the appearance settings route', async () => {
    const { api, calls } = respond(200, { sidebarSide: 'right', canChange: true });
    expect(await api.load()).toEqual({ sidebarSide: 'right', canChange: true });
    expect(calls).toEqual([{ path: '/api/mittr/appearance/settings', method: 'GET', body: null }]);
  });

  test('a change is one PUT of the side and answers what was stored', async () => {
    const { api, calls } = respond(200, { sidebarSide: 'left', canChange: true });
    expect(await api.save('left')).toEqual({ sidebarSide: 'left', canChange: true });
    expect(calls).toEqual([{ path: '/api/mittr/appearance/settings', method: 'PUT', body: { sidebarSide: 'left' } }]);
  });

  test('a reply that is not the settings shape, an error or no answer is a failure', async () => {
    await refusedWith(respond(200, { sidebarSide: 'top', canChange: true }).api.load(), mittrT('mittr.sidebarSide.errors.loadFailed'), 200);
    await refusedWith(respond(200, 'not json').api.load(), mittrT('mittr.sidebarSide.errors.loadFailed'), 200);
    await refusedWith(respond(403, { error: 'These settings can be changed only on this Mac' }).api.save('right'), 'These settings can be changed only on this Mac', 403);
    const offline: SidebarSideFetch = async () => { throw new TypeError('network down'); };
    await refusedWith(createSidebarSideApi(offline).save('right'), mittrT('mittr.sidebarSide.errors.saveFailed'), null);
  });
});

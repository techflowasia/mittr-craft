import type { JsonValue } from '@openchamber/sdk';
import { describe, expect, test } from 'bun:test';

import { mittrT } from '../strings/mittrT';
import { createToolsApi, ToolsRequestError, type ToolsFetch } from './toolsApi';

type Call = { path: string; method: string; body: JsonValue | null };

const respond = (status: number, body: JsonValue | 'not json') => {
  const calls: Call[] = [];
  const fetchImpl: ToolsFetch = async (path, init) => {
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
  return { api: createToolsApi(fetchImpl), calls };
};

const TOOLS = {
  computer: { offered: true, enabled: true },
  chrome: { offered: true, chromeInstalled: true, enabled: true, profile: 'Default', headed: false, approvedHosts: ['jira.acme.test'] },
};

const refusedWith = async (work: Promise<object>, message: string, status: number | null) => {
  const error = await work.then(() => null, (caught: Error) => caught);
  expect(error).toBeInstanceOf(ToolsRequestError);
  expect(error?.message).toBe(message);
  expect(error instanceof ToolsRequestError ? error.status : undefined).toBe(status);
};

describe('MittrCraft tools API', () => {
  test('the tools are read from the Mittr tools route', async () => {
    const { api, calls } = respond(200, TOOLS);
    expect(await api.load()).toEqual(TOOLS);
    expect(calls).toEqual([{ path: '/api/mittr/tools', method: 'GET', body: null }]);
  });

  test('a change is sent as one PUT and answers the stored tools', async () => {
    const { api, calls } = respond(200, TOOLS);
    expect(await api.save({ chromeHeaded: true })).toEqual(TOOLS);
    expect(calls).toEqual([{ path: '/api/mittr/tools', method: 'PUT', body: { chromeHeaded: true } }]);
  });

  test('a reply that is not the tools shape is a failure, never empty tools', async () => {
    await refusedWith(respond(200, { computer: { offered: true } }).api.load(), mittrT('mittr.tools.errors.loadFailed'), 200);
    await refusedWith(respond(200, 'not json').api.load(), mittrT('mittr.tools.errors.loadFailed'), 200);
    await refusedWith(respond(500, { error: 'Cannot store the tool setting on this machine' }).api.save({ chrome: false }), 'Cannot store the tool setting on this machine', 500);
    const offline: ToolsFetch = async () => { throw new TypeError('network down'); };
    await refusedWith(createToolsApi(offline).save({ chrome: false }), mittrT('mittr.tools.errors.saveFailed'), null);
  });

  test('profiles and a removed site read their own routes', async () => {
    const profiles = respond(200, { profiles: [{ directory: 'Default', name: 'Person' }] });
    expect(await profiles.api.profiles()).toEqual([{ directory: 'Default', name: 'Person' }]);
    expect(profiles.calls[0].path).toBe('/api/mittr/tools/chrome/profiles');

    const removed = respond(200, { hosts: [] });
    expect(await removed.api.removeHost('jira.acme.test')).toEqual([]);
    expect(removed.calls).toEqual([{ path: '/api/mittr/tools/chrome/approved-hosts/jira.acme.test', method: 'DELETE', body: null }]);

    await refusedWith(respond(502, { error: 'Could not list the Chrome profiles on this Mac' }).api.profiles(), 'Could not list the Chrome profiles on this Mac', 502);
    await refusedWith(respond(200, { hosts: 'none' }).api.removeHost('a.test'), mittrT('mittr.tools.errors.removeFailed', { host: 'a.test' }), 200);
  });
});

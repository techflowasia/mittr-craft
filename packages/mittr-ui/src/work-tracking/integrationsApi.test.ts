import type { JsonValue } from '@openchamber/sdk';
import { describe, expect, test } from 'bun:test';

import { mittrT } from '../strings/mittrT';
import { createIntegrationsApi, IntegrationsRequestError, type IntegrationsFetch } from './integrationsApi';

type Call = { path: string; method: string; body: JsonValue | null };

const respond = (status: number, body: JsonValue | 'not json') => {
  const calls: Call[] = [];
  const fetchImpl: IntegrationsFetch = async (path, init) => {
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
  return { api: createIntegrationsApi(fetchImpl), calls };
};

const failing: IntegrationsFetch = async () => {
  throw new TypeError('network down');
};

const GET_REPLY = {
  jira: { baseUrl: 'https://acme.atlassian.net', email: 'a@acme.test', hasToken: true, configured: true },
  plane: { baseUrl: 'https://plane.example.com', workspaceSlug: 'alpha', workspaceSlugs: ['alpha', 'beta'], hasApiKey: false, configured: true },
  userId: 'u-a',
};

describe('integrations API', () => {
  test('the settings are read from the Mittr integrations route', async () => {
    const { api, calls } = respond(200, GET_REPLY);
    expect(await api.load()).toEqual(GET_REPLY);
    expect(calls).toEqual([{ path: '/api/mittr/integrations', method: 'GET', body: null }]);
  });

  test('a platform without workspaceSlugs and with no Jira block still reads as settings', async () => {
    const { api } = respond(200, { plane: { baseUrl: '', workspaceSlug: '', hasApiKey: false, configured: false }, userId: 'u-a' });
    const config = await api.load();
    expect(config.jira).toEqual({ baseUrl: '', email: '', hasToken: false, configured: false });
    expect(config.plane).toEqual({ baseUrl: '', workspaceSlug: '', hasApiKey: false, configured: false });
    expect('workspaceSlugs' in config.plane).toBe(false);
  });

  test('a refused read says why, and an unreadable one says it could not load', async () => {
    await expect(respond(401, { error: 'Sign in to Mittr first' }).api.load()).rejects.toThrow('Sign in to Mittr first');
    await expect(respond(500, 'not json').api.load()).rejects.toThrow(mittrT('mittr.workTracking.errors.loadFailed'));
    await expect(respond(200, 'not json').api.load()).rejects.toThrow(mittrT('mittr.workTracking.errors.loadFailed'));
    await expect(createIntegrationsApi(failing).load()).rejects.toThrow(mittrT('mittr.workTracking.errors.loadFailed'));
  });

  test('a save is a PUT of exactly the body it is given', async () => {
    const { api, calls } = respond(200, GET_REPLY);
    const body = { jira: { baseUrl: 'https://acme.atlassian.net', email: 'a@acme.test', token: 'secret' }, expectUserId: 'u-a' };
    expect(await api.save(body)).toEqual(GET_REPLY);
    expect(calls).toEqual([{ path: '/api/mittr/integrations', method: 'PUT', body }]);
  });

  test('a refused save keeps its status so a changed account can be told apart', async () => {
    const error = await respond(409, { error: 'The Mittr account changed. Open the settings again.' }).api.save({ expectUserId: 'u-a' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IntegrationsRequestError);
    expect((error as IntegrationsRequestError).status).toBe(409);
    const offline = await createIntegrationsApi(failing).save({ expectUserId: 'u-a' }).catch((caught: unknown) => caught);
    expect((offline as IntegrationsRequestError).status).toBeNull();
    expect((offline as Error).message).toBe(mittrT('mittr.workTracking.toast.saveFailed'));
  });

  test('the connection tests post to their own routes and pass the result through', async () => {
    const plane = respond(200, { ok: true, count: 7, workspaces: [{ slug: 'alpha', ok: true, count: 4 }, { slug: 'beta', ok: false, count: 0, error: 'Forbidden' }], userId: 'u-a' });
    expect(await plane.api.testPlane()).toEqual({
      ok: true,
      count: 7,
      workspaces: [{ slug: 'alpha', ok: true, count: 4 }, { slug: 'beta', ok: false, count: 0, error: 'Forbidden' }],
      userId: 'u-a',
    });
    expect(plane.calls).toEqual([{ path: '/api/mittr/integrations/plane/test', method: 'POST', body: null }]);

    const jira = respond(200, { ok: true, displayName: 'Acme Person', userId: 'u-a' });
    expect(await jira.api.testJira()).toEqual({ ok: true, displayName: 'Acme Person', userId: 'u-a' });
    expect(jira.calls[0].path).toBe('/api/mittr/integrations/jira/test');
  });

  test('a failed connection test answers not ok with the reason', async () => {
    expect(await respond(502, { error: 'Cannot reach Mittr' }).api.testJira()).toEqual({ ok: false, error: 'Cannot reach Mittr' });
    expect(await respond(500, 'not json').api.testPlane()).toEqual({ ok: false, error: mittrT('mittr.workTracking.toast.testFailed') });
    expect(await createIntegrationsApi(failing).testPlane()).toEqual({ ok: false, error: mittrT('mittr.workTracking.toast.testFailed') });
  });
});

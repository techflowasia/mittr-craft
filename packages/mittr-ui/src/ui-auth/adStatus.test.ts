import type { JsonValue } from '@openchamber/sdk';
import { describe, expect, test } from 'bun:test';

import { AD_STATUS_ENDPOINT, fetchAdStatus, type AdFetch } from './adStatus';

const answer = (status: number, body: JsonValue): AdFetch => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('fetchAdStatus', () => {
  test('reads the Entra status', async () => {
    const status = await fetchAdStatus(answer(200, { enabled: true, mode: 'entra', passwordEnabled: false, tunnelLocked: false }));
    expect(status).toEqual({ enabled: true, mode: 'entra', passwordEnabled: false, tunnelLocked: false });
  });

  test('reads the LDAP status and asks the status endpoint with the session cookie', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const status = await fetchAdStatus(async (path, init) => {
      calls.push({ path, init });
      return { ok: true, status: 200, json: async () => ({ enabled: true, mode: 'ldap', passwordEnabled: true, tunnelLocked: false }) };
    });
    expect(status).toEqual({ enabled: true, mode: 'ldap', passwordEnabled: true, tunnelLocked: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(AD_STATUS_ENDPOINT);
    expect(calls[0].init?.credentials).toBe('include');
  });

  test('a 403 under tunnel scope is not available here, and does not throw', async () => {
    const status = await fetchAdStatus(answer(403, { error: 'Company sign-in is disabled for tunnel scope', tunnelLocked: true }));
    expect(status.enabled).toBe(false);
    expect(status.tunnelLocked).toBe(true);
  });

  test('a failed request is not available and does not throw', async () => {
    const status = await fetchAdStatus(async () => { throw new Error('offline'); });
    expect(status).toEqual({ enabled: false, passwordEnabled: true, tunnelLocked: false });
  });

  test('a server error, a body that is not JSON and an unknown mode are not available', async () => {
    expect((await fetchAdStatus(answer(502, {}))).enabled).toBe(false);
    expect((await fetchAdStatus(async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }))).enabled).toBe(false);
    expect((await fetchAdStatus(answer(200, { enabled: true, mode: 'saml', passwordEnabled: true, tunnelLocked: false }))).enabled).toBe(false);
  });

  test('a status that says nothing about the password keeps the password form', async () => {
    expect((await fetchAdStatus(answer(200, { enabled: true, mode: 'ldap' }))).passwordEnabled).toBe(true);
    expect((await fetchAdStatus(answer(200, { enabled: false }))).enabled).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';

import type { JsonValue } from '@openchamber/sdk';

import {
  ACCOUNTS_ENDPOINT,
  ACTIVATE_ENDPOINT,
  RETRY_SWITCH_ENDPOINT,
  SESSION_ENDPOINT,
  createAccountsApi,
  type AccountsFetch,
  type AccountsResponse,
} from './accountsApi';

type Call = { path: string; method: string; body?: string };

const A = { userId: 'u-a', displayName: 'Ann Lee', active: false };
const B = { userId: 'u-b', displayName: 'Bo', active: true };

const answering = (body: JsonValue, status = 200) => {
  const calls: Call[] = [];
  const fetch: AccountsFetch = async (path, init) => {
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body });
    const response: AccountsResponse = { ok: status >= 200 && status < 300, status, json: async () => body };
    return response;
  };
  return { fetch, calls };
};

const offline: AccountsFetch = () => Promise.reject(new Error('offline'));

const apiWith = (fetch: AccountsFetch, openUrl: (url: string) => Promise<boolean> = async () => true) => createAccountsApi({ fetch, openUrl });

describe('accounts api', () => {
  test('fetchAccounts unwraps the accounts list', async () => {
    const http = answering({ accounts: [A, B] });
    expect(await apiWith(http.fetch).fetchAccounts()).toEqual([A, B]);
    expect(http.calls).toEqual([{ path: ACCOUNTS_ENDPOINT, method: 'GET', body: undefined }]);
  });

  test('a list that cannot be read is a failure, never an empty list', async () => {
    await expect(apiWith(answering({ accounts: [A] }, 500).fetch).fetchAccounts()).rejects.toThrow('HTTP 500');
    await expect(apiWith(answering({ list: [A] }).fetch).fetchAccounts()).rejects.toThrow();
    await expect(apiWith(offline).fetchAccounts()).rejects.toThrow('offline');
  });

  test('activateAccount posts the account and hands back how the switch went', async () => {
    const http = answering({ signedIn: true, userId: 'u-a', displayName: 'Ann Lee' });
    expect(await apiWith(http.fetch).activateAccount('u-a')).toEqual({ signedIn: true, userId: 'u-a' });
    expect(http.calls).toEqual([{ path: ACTIVATE_ENDPOINT, method: 'POST', body: JSON.stringify({ userId: 'u-a' }) }]);

    const stuck = answering({ signedIn: true, userId: 'u-a', engineRestarted: false });
    expect(await apiWith(stuck.fetch).activateAccount('u-a')).toEqual({ signedIn: true, userId: 'u-a', engineRestarted: false });

    await expect(apiWith(answering({ error: 'That account is not signed in on this machine' }, 404).fetch).activateAccount('nobody')).rejects.toThrow('HTTP 404');
  });

  test('signing out deletes the session and says whether someone is still signed in', async () => {
    const http = answering({ signedIn: false });
    expect(await apiWith(http.fetch).signOutActive()).toEqual({ signedIn: false });
    expect(http.calls).toEqual([{ path: SESSION_ENDPOINT, method: 'DELETE', body: undefined }]);

    const next = answering({ signedIn: true, userId: 'u-b', displayName: 'Bo', engineRestarted: false });
    expect(await apiWith(next.fetch).signOutActive()).toEqual({ signedIn: true, userId: 'u-b', engineRestarted: false });
    await expect(apiWith(answering({}, 503).fetch).signOutActive()).rejects.toThrow('HTTP 503');
  });

  test('a retry asks the server to finish the switch for the account already active', async () => {
    const http = answering({ signedIn: true, userId: 'u-b', displayName: 'Bo' });
    expect(await apiWith(http.fetch).retrySwitch()).toEqual({ signedIn: true, userId: 'u-b' });
    expect(http.calls).toEqual([{ path: RETRY_SWITCH_ENDPOINT, method: 'POST', body: undefined }]);
  });

  test('adding an account opens the sign-in page in the browser, and says when it could not', async () => {
    const opened: string[] = [];
    const openUrl = async (url: string) => { opened.push(url); return true; };
    const http = answering({ authorizeUrl: 'https://api-dev.mittr.asia/auth/desktop/start?code_challenge=x' });
    expect(await apiWith(http.fetch, openUrl).startAddAccount()).toBe(true);
    expect(http.calls).toEqual([{ path: '/api/mittr/auth/start', method: 'POST', body: undefined }]);
    expect(opened).toEqual(['https://api-dev.mittr.asia/auth/desktop/start?code_challenge=x']);

    expect(await apiWith(answering({ authorizeUrl: 'file:///etc/passwd' }).fetch, openUrl).startAddAccount()).toBe(false);
    expect(await apiWith(answering({ error: 'no keychain' }, 503).fetch, openUrl).startAddAccount()).toBe(false);
    expect(await apiWith(offline, openUrl).startAddAccount()).toBe(false);
    expect(await apiWith(http.fetch, async () => false).startAddAccount()).toBe(false);
    expect(opened).toHaveLength(1);
  });
});

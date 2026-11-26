import { describe, expect, test } from 'bun:test';

import type { JsonValue } from '@openchamber/sdk';

import {
  ACCOUNTS_ENDPOINT,
  ACTIVATE_ENDPOINT,
  RETRY_SWITCH_ENDPOINT,
  SESSION_ENDPOINT,
  createAccountsApi,
  HttpError,
  isEngineRefusal,
  type AccountsFetch,
  type AccountsResponse,
  type SwitchOutcome, initialsOf } from './accountsApi';

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

const V1 = { code: 'MITTR_ENGINE_V1_HISTORY', message: 'Open MittrCraft 2.1.1 once.' };

const failureOf = async (request: Promise<SwitchOutcome>): Promise<HttpError> => {
  try {
    await request;
  } catch (error) {
    if (error instanceof HttpError) return error;
  }
  throw new Error('expected an HttpError');
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

  test('a refused request carries why and its code, and a body without them carries neither', async () => {
    const refused = await failureOf(apiWith(answering({ error: V1.message, code: V1.code }, 409).fetch).activateAccount('u-a'));
    expect([refused.status, refused.error, refused.code, refused.message]).toEqual([409, V1.message, V1.code, 'HTTP 409']);

    const noCode = await failureOf(apiWith(answering({ error: 'Cannot store' }, 500).fetch).activateAccount('u-a'));
    expect([noCode.error, noCode.code]).toEqual(['Cannot store', null]);

    for (const body of [null, 'plain text', { error: 7, code: {} }]) {
      const odd = await failureOf(apiWith(answering(body, 502).fetch).retrySwitch());
      expect([odd.status, odd.error, odd.code]).toEqual([502, null, null]);
    }

    const notJson: AccountsFetch = async () => ({ ok: false, status: 504, json: () => Promise.reject(new SyntaxError('not json')) });
    const unread = await failureOf(apiWith(notJson).retrySwitch());
    expect([unread.status, unread.error, unread.code]).toEqual([504, null, null]);
  });

  test('a switch whose engine did not start keeps the engine error, and a refused sign-in switch keeps its reason', async () => {
    const stuck = { signedIn: true, userId: 'u-a', engineRestarted: false, engineError: V1 } as const;
    expect(await apiWith(answering({ ...stuck, displayName: 'Ann Lee' }).fetch).activateAccount('u-a')).toEqual(stuck);

    const unnamed = { signedIn: true, userId: 'u-a', engineRestarted: false, engineError: { code: null, message: 'engine did not come back' } } as const;
    expect(await apiWith(answering(unnamed).fetch).retrySwitch()).toEqual(unnamed);

    const bad = { signedIn: true, engineRestarted: false, engineError: 'boom', switchRefused: { code: 'x' } };
    expect(await apiWith(answering(bad).fetch).retrySwitch()).toEqual({ signedIn: true, engineRestarted: false });

    expect(await apiWith(answering({ signedIn: true, userId: 'u-b', switchRefused: V1 }).fetch).retrySwitch()).toEqual({ signedIn: true, userId: 'u-b', switchRefused: V1 });
  });

  test('the account list says when the last sign-in was not switched to, and a server that does not say reads as none', async () => {
    expect(await apiWith(answering({ accounts: [A, B], switchRefused: { userId: 'u-a', ...V1 } }).fetch).fetchAccountList()).toEqual({ accounts: [A, B], switchRefused: V1 });
    expect(await apiWith(answering({ accounts: [A, B] }).fetch).fetchAccountList()).toEqual({ accounts: [A, B], switchRefused: null });
    expect(await apiWith(answering({ accounts: [A, B], switchRefused: 'yes' }).fetch).fetchAccountList()).toEqual({ accounts: [A, B], switchRefused: null });
  });

  test('only the engine\'s own refusals are worth showing as they are', () => {
    expect(isEngineRefusal(V1)).toBe(true);
    expect(isEngineRefusal({ code: 'MITTR_ENGINE_DATABASE_BUSY', message: 'x' })).toBe(true);
    expect(isEngineRefusal({ code: 'EACCES', message: 'x' })).toBe(false);
    expect(isEngineRefusal({ code: null, message: 'x' })).toBe(false);
    expect(isEngineRefusal(null)).toBe(false);
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

  test('cancelling an add asks the server to drop the sign-in it started, and a failed request is not thrown', async () => {
    const http = answering({});
    await apiWith(http.fetch).cancelAddAccount();
    expect(http.calls).toEqual([{ path: '/api/mittr/auth/start', method: 'DELETE', body: undefined }]);
    await apiWith(offline).cancelAddAccount();
    await apiWith(answering({ error: 'x' }, 500).fetch).cancelAddAccount();
  });
});

test('initials skip brackets and other signs around a name', () => {
  expect(initialsOf('Somchai (Dev)')).toBe('SD');
  expect(initialsOf('Somchai (')).toBe('S');
  expect(initialsOf('สมชาย ใจดี')).toBe('สใ');
  expect(initialsOf('---')).toBe('');
});

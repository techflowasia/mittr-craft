import type { JsonValue } from '@openchamber/sdk';
import { z } from 'zod';

import { runtimeFetch } from '../../../ui/src/lib/runtime-fetch';
import { openExternalUrl } from '../../../ui/src/lib/url';
import { parseAuthorizeUrl, SIGN_IN_START_ENDPOINT } from '../sign-in/signInGateState';

export const ACCOUNTS_ENDPOINT = '/api/mittr/auth/accounts';
export const ACTIVATE_ENDPOINT = '/api/mittr/auth/accounts/activate';
export const RETRY_SWITCH_ENDPOINT = '/api/mittr/auth/accounts/retry-switch';
export const SESSION_ENDPOINT = '/api/mittr/auth/session';

export type MittrAccount = { userId: string; displayName: string; active: boolean };

export type SwitchOutcome = { signedIn: boolean; userId?: string; engineRestarted?: false };

export type AccountsResponse = { ok: boolean; status: number; json: () => Promise<JsonValue> };
export type AccountsFetch = (
  path: string,
  init?: { method?: 'POST' | 'DELETE'; headers?: Record<string, string>; body?: string },
) => Promise<AccountsResponse>;

export type AccountsApiDeps = {
  fetch: AccountsFetch;
  openUrl: (url: string) => Promise<boolean>;
};

export type AccountsApi = {
  fetchAccounts: () => Promise<MittrAccount[]>;
  activateAccount: (userId: string) => Promise<SwitchOutcome>;
  signOutActive: () => Promise<SwitchOutcome>;
  retrySwitch: () => Promise<SwitchOutcome>;
  startAddAccount: () => Promise<boolean>;
};

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

const firstLetter = (word: string): string => Array.from(word)[0] ?? '';

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const first = firstLetter(words[0]);
  const last = words.length > 1 ? firstLetter(words[words.length - 1]) : '';
  return `${first}${last}`.toLocaleUpperCase();
}

export const accountName = (account: MittrAccount): string => account.displayName.trim() || account.userId;

const accountsPayload = z.object({
  accounts: z.array(z.object({
    userId: z.string().min(1),
    displayName: z.string().catch(''),
    active: z.boolean().catch(false),
  })),
});

const outcomePayload = z.object({
  signedIn: z.boolean(),
  userId: z.string().optional().catch(undefined),
  engineRestarted: z.literal(false).optional().catch(undefined),
});

const parseOutcome = (payload: JsonValue): SwitchOutcome => {
  const { signedIn, userId, engineRestarted } = outcomePayload.parse(payload);
  const outcome: SwitchOutcome = { signedIn };
  if (signedIn && userId !== undefined) outcome.userId = userId;
  if (engineRestarted === false) outcome.engineRestarted = false;
  return outcome;
};

const readOk = async (response: AccountsResponse): Promise<JsonValue> => {
  if (!response.ok) throw new HttpError(response.status);
  return response.json();
};

export function createAccountsApi({ fetch, openUrl }: AccountsApiDeps): AccountsApi {
  const switchBy = async (path: string, init: Parameters<AccountsFetch>[1]) => parseOutcome(await readOk(await fetch(path, init)));

  return {
    fetchAccounts: async () => accountsPayload.parse(await readOk(await fetch(ACCOUNTS_ENDPOINT))).accounts,
    activateAccount: (userId) => switchBy(ACTIVATE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    }),
    signOutActive: () => switchBy(SESSION_ENDPOINT, { method: 'DELETE' }),
    retrySwitch: () => switchBy(RETRY_SWITCH_ENDPOINT, { method: 'POST' }),
    startAddAccount: async () => {
      try {
        const authorizeUrl = parseAuthorizeUrl(await readOk(await fetch(SIGN_IN_START_ENDPOINT, { method: 'POST' })));
        return authorizeUrl ? await openUrl(authorizeUrl) : false;
      } catch {
        return false;
      }
    },
  };
}

export const accountsApi: AccountsApi = createAccountsApi({
  fetch: (path, init) => runtimeFetch(path, init),
  openUrl: openExternalUrl,
});

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

export type SwitchProblem = { code: string | null; message: string };

export type SwitchOutcome = {
  signedIn: boolean;
  userId?: string;
  engineRestarted?: false;
  engineError?: SwitchProblem;
  switchRefused?: SwitchProblem;
  reloadOwed?: true;
};

export type AccountList = { accounts: MittrAccount[]; switchRefused: SwitchProblem | null };

export const isEngineRefusal = (problem: SwitchProblem | null): problem is SwitchProblem => problem?.code?.startsWith('MITTR_ENGINE_') === true;

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
  fetchAccountList: () => Promise<AccountList>;
  activateAccount: (userId: string) => Promise<SwitchOutcome>;
  signOutActive: () => Promise<SwitchOutcome>;
  retrySwitch: () => Promise<SwitchOutcome>;
  startAddAccount: () => Promise<boolean>;
  cancelAddAccount: () => Promise<void>;
};

export class HttpError extends Error {
  readonly status: number;
  readonly error: string | null;
  readonly code: string | null;

  constructor(status: number, { error = null, code = null }: { error?: string | null; code?: string | null } = {}) {
    super(`HTTP ${status}`);
    this.status = status;
    this.error = error;
    this.code = code;
  }
}

const firstLetter = (word: string): string => /[\p{L}\p{N}]/u.exec(word)?.[0] ?? '';

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => firstLetter(word) !== '');
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

const problemPayload = z.object({
  code: z.string().nullable().catch(null),
  message: z.string().min(1),
});

const refusalPayload = z.object({ switchRefused: problemPayload.nullable().catch(null).default(null) });

const errorPayload = z.object({
  error: z.string().nullable().catch(null).default(null),
  code: z.string().nullable().catch(null).default(null),
});

export const parseAccounts = (payload: JsonValue): MittrAccount[] => accountsPayload.parse(payload).accounts;

const outcomePayload = z.object({
  signedIn: z.boolean(),
  userId: z.string().optional().catch(undefined),
  engineRestarted: z.literal(false).optional().catch(undefined),
  engineError: problemPayload.optional().catch(undefined),
  switchRefused: problemPayload.optional().catch(undefined),
});

const parseOutcome = (payload: JsonValue): SwitchOutcome => {
  const { signedIn, userId, engineRestarted, engineError, switchRefused } = outcomePayload.parse(payload);
  const outcome: SwitchOutcome = { signedIn };
  if (signedIn && userId !== undefined) outcome.userId = userId;
  if (engineRestarted === false) {
    outcome.engineRestarted = false;
    if (engineError) outcome.engineError = engineError;
  }
  if (switchRefused) outcome.switchRefused = switchRefused;
  return outcome;
};

const readError = async (response: AccountsResponse): Promise<HttpError> => {
  const body = errorPayload.safeParse(await response.json().catch(() => null));
  return new HttpError(response.status, body.success ? body.data : {});
};

const readOk = async (response: AccountsResponse): Promise<JsonValue> => {
  if (!response.ok) throw await readError(response);
  return response.json();
};

export function createAccountsApi({ fetch, openUrl }: AccountsApiDeps): AccountsApi {
  const switchBy = async (path: string, init: Parameters<AccountsFetch>[1]) => parseOutcome(await readOk(await fetch(path, init)));

  return {
    fetchAccounts: async () => parseAccounts(await readOk(await fetch(ACCOUNTS_ENDPOINT))),
    fetchAccountList: async () => {
      const payload = await readOk(await fetch(ACCOUNTS_ENDPOINT));
      return { accounts: parseAccounts(payload), switchRefused: refusalPayload.parse(payload).switchRefused };
    },
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
    cancelAddAccount: async () => {
      try {
        await fetch(SIGN_IN_START_ENDPOINT, { method: 'DELETE' });
      } catch {
        return;
      }
    },
  };
}

export const accountsApi: AccountsApi = createAccountsApi({
  fetch: (path, init) => runtimeFetch(path, init),
  openUrl: openExternalUrl,
});

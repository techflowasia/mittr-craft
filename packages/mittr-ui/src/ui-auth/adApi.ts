import type { JsonValue } from '@openchamber/sdk';
import { z } from 'zod';

import { mittrT } from '../strings/mittrT';
import type { SessionAuthRuntime } from '../../../ui/src/lib/product-plugins';
import type { RuntimeUrlQuery } from '../../../ui/src/lib/runtime-url';
import { defaultAdFetch, JSON_CREDENTIALS_INIT, type AdFetch, type AdResponse } from './adStatus';

export const AD_SESSION_ENDPOINT = '/auth/ad/session';
export const AD_LOGIN_ENDPOINT = '/auth/ad/login';
export const TRUST_DEVICE_STORAGE_KEY = 'openchamber.uiAuth.trustDevice';

export type AdFailureReason = 'invalid' | 'rate-limited' | 'not-configured' | 'use-microsoft' | 'failed';

export type AdSessionResult =
  | { ok: true; clientToken?: string }
  | { ok: false; reason: AdFailureReason; retryAfterSeconds?: number };

const sessionPayload = z.object({ clientToken: z.string().trim().min(1).optional().catch(undefined) });

const refusalPayload = z.object({
  code: z.string().optional().catch(undefined),
  retryAfter: z.number().positive().finite().optional().catch(undefined),
});

const retryAfterHeader = (response: AdResponse): number | undefined => {
  const seconds = Number(response.headers?.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
};

const refusalOf = async (response: AdResponse): Promise<AdSessionResult> => {
  const refusal = refusalPayload.safeParse(await response.json().catch(() => null));
  const body = refusal.success ? refusal.data : {};
  if (response.status === 429) {
    const retryAfterSeconds = body.retryAfter ?? retryAfterHeader(response);
    return retryAfterSeconds === undefined ? { ok: false, reason: 'rate-limited' } : { ok: false, reason: 'rate-limited', retryAfterSeconds };
  }
  if (response.status === 400 && body.code === 'not-configured') return { ok: false, reason: 'not-configured' };
  if (response.status === 400 && body.code === 'use-microsoft') return { ok: false, reason: 'use-microsoft' };
  if (response.status === 401 || response.status === 400) return { ok: false, reason: 'invalid' };
  return { ok: false, reason: 'failed' };
};

export function failureMessage(failure: Extract<AdSessionResult, { ok: false }>): string {
  switch (failure.reason) {
    case 'invalid': return mittrT('mittr.uiAuth.invalid');
    case 'not-configured': return mittrT('mittr.uiAuth.notConfigured');
    case 'use-microsoft': return mittrT('mittr.uiAuth.useMicrosoft');
    case 'rate-limited': {
      if (failure.retryAfterSeconds === undefined) return mittrT('mittr.uiAuth.rateLimited');
      const minutes = Math.ceil(failure.retryAfterSeconds / 60);
      return mittrT(minutes === 1 ? 'mittr.uiAuth.rateLimitedMinute' : 'mittr.uiAuth.rateLimitedMinutes', { minutes });
    }
    case 'failed': return mittrT('mittr.uiAuth.failed');
  }
}

export function failureAfterWait(failure: Extract<AdSessionResult, { ok: false }> | null): Extract<AdSessionResult, { ok: false }> | null {
  return failure?.reason === 'rate-limited' ? null : failure;
}

export function endLockout({ setBlockedUntil, setFailure }: {
  setBlockedUntil: (next: number) => void;
  setFailure: (next: (current: Extract<AdSessionResult, { ok: false }> | null) => Extract<AdSessionResult, { ok: false }> | null) => void;
}): void {
  setBlockedUntil(0);
  setFailure(failureAfterWait);
}

export async function submitAdSession({ fetch, username, password, trustDevice, issueClientToken = false }: {
  fetch: AdFetch;
  username: string;
  password: string;
  trustDevice: boolean;
  issueClientToken?: boolean;
}): Promise<AdSessionResult> {
  try {
    const response = await fetch(AD_SESSION_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(issueClientToken
        ? { username, password, trustDevice, issueClientToken: true }
        : { username, password, trustDevice }),
    });
    if (response.ok) {
      const parsed = sessionPayload.safeParse(await response.json().catch(() => null));
      const clientToken = parsed.success ? parsed.data.clientToken : undefined;
      return clientToken ? { ok: true, clientToken } : { ok: true };
    }
    return await refusalOf(response);
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export async function signInWithDirectory({ runtime, onSignedIn, ...attempt }: {
  fetch: AdFetch;
  username: string;
  password: string;
  trustDevice: boolean;
  runtime: SessionAuthRuntime;
  onSignedIn: (clientToken?: string) => Promise<boolean>;
}): Promise<AdSessionResult> {
  const result = await submitAdSession({ ...attempt, issueClientToken: runtime === 'desktop-remote' });
  if (!result.ok) return result;
  return await onSignedIn(result.clientToken) ? { ok: true } : { ok: false, reason: 'failed' };
}

export function entraLoginUrl(
  auth: (path: string, query?: RuntimeUrlQuery) => string,
  current: { pathname: string; search: string },
  trustDevice: boolean,
): string {
  return auth(AD_LOGIN_ENDPOINT, {
    returnTo: `${current.pathname}${current.search}`,
    trustDevice: trustDevice ? 'true' : undefined,
  });
}

export const readStoredTrustDevice = (): boolean => {
  try {
    return window.localStorage.getItem(TRUST_DEVICE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
};

export const storeTrustDevice = (value: boolean): void => {
  try {
    window.localStorage.setItem(TRUST_DEVICE_STORAGE_KEY, value ? 'true' : 'false');
  } catch {
    return;
  }
};

export const AD_PROFILE_ENDPOINT = '/auth/ad/profile';
export const SESSION_ENDPOINT = '/auth/session';

export type AdProfile = { displayName: string; title: string | null; department: string | null };

const optionalText = z.string().optional().catch(undefined).transform((value) => value?.trim() || null);

const profilePayload = z.object({
  profile: z.object({
    displayName: optionalText,
    username: optionalText,
    email: optionalText,
    title: optionalText,
    department: optionalText,
  }),
});

export function parseAdProfile(payload: JsonValue): AdProfile | null {
  const parsed = profilePayload.safeParse(payload);
  if (!parsed.success) return null;
  const { displayName, username, email, title, department } = parsed.data.profile;
  const name = displayName ?? username ?? email;
  return name ? { displayName: name, title, department } : null;
}

export async function loadAdProfile(fetch: AdFetch = defaultAdFetch): Promise<AdProfile | null> {
  try {
    const response = await fetch(AD_PROFILE_ENDPOINT, JSON_CREDENTIALS_INIT);
    return response.ok ? parseAdProfile(await response.json()) : null;
  } catch {
    return null;
  }
}

export async function signOutAd(fetch: AdFetch = defaultAdFetch): Promise<boolean> {
  try {
    const response = await fetch(SESSION_ENDPOINT, { ...JSON_CREDENTIALS_INIT, method: 'DELETE' });
    return response.ok;
  } catch {
    return false;
  }
}

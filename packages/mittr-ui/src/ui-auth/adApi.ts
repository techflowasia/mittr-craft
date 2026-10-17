import type { JsonValue } from '@openchamber/sdk';
import { z } from 'zod';

import type { SessionAuthRuntime } from '../../../ui/src/lib/product-plugins';
import type { RuntimeUrlQuery } from '../../../ui/src/lib/runtime-url';
import { defaultAdFetch, JSON_CREDENTIALS_INIT, type AdFetch } from './adStatus';

export const AD_SESSION_ENDPOINT = '/auth/ad/session';
export const AD_LOGIN_ENDPOINT = '/auth/ad/login';
export const TRUST_DEVICE_STORAGE_KEY = 'openchamber.uiAuth.trustDevice';

export const DESKTOP_CLIENT_LABEL = 'MittrCraft Desktop';

export type AdSessionResult = { ok: true; clientToken?: string } | { ok: false; reason: 'invalid' | 'rate-limited' | 'failed' };

const sessionPayload = z.object({ clientToken: z.string().trim().min(1).optional().catch(undefined) });

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
        ? { username, password, trustDevice, issueClientToken: true, clientLabel: DESKTOP_CLIENT_LABEL }
        : { username, password, trustDevice }),
    });
    if (response.ok) {
      const parsed = sessionPayload.safeParse(await response.json().catch(() => null));
      const clientToken = parsed.success ? parsed.data.clientToken : undefined;
      return clientToken ? { ok: true, clientToken } : { ok: true };
    }
    if (response.status === 401 || response.status === 400) return { ok: false, reason: 'invalid' };
    if (response.status === 429) return { ok: false, reason: 'rate-limited' };
    return { ok: false, reason: 'failed' };
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

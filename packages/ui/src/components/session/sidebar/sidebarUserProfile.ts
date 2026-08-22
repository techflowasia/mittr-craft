import { runtimeFetch } from '@/lib/runtime-fetch';
import { z } from 'zod';

export type SidebarUserProfile = {
  username: string | null;
  displayName: string;
  email: string | null;
  department: string | null;
  title: string | null;
  groups: string[];
  secondaryLabel: string | null;
};

export type SidebarUserProfileResult =
  | { status: 'ready'; profile: SidebarUserProfile }
  | { status: 'auth-required' | 'reauth-required' | 'unavailable' };

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const optionalProfileStringSchema = z.string().trim().min(1).nullable().catch(null);
const sidebarUserProfilePayloadSchema = z.object({
  profile: z.object({
    username: optionalProfileStringSchema,
    displayName: optionalProfileStringSchema,
    email: optionalProfileStringSchema,
    department: optionalProfileStringSchema,
    title: optionalProfileStringSchema,
    groups: z.array(z.string().trim().min(1).nullable().catch(null)).catch([]),
  }),
});
const adEnabledStatusSchema = z.object({ enabled: z.literal(true) });

export const parseSidebarUserProfile = (value: JsonValue): SidebarUserProfile | null => {
  const parsed = sidebarUserProfilePayloadSchema.safeParse(value);
  if (!parsed.success) return null;
  const { displayName, username, email, department, title } = parsed.data.profile;
  const groups = parsed.data.profile.groups.filter((group) => group !== null);
  const primaryLabel = displayName ?? username ?? email;
  if (!primaryLabel) return null;

  const secondaryLabel = email && email !== primaryLabel
    ? email
    : username && username !== primaryLabel
      ? username
      : null;

  return {
    username,
    displayName: primaryLabel,
    email,
    department,
    title,
    groups,
    secondaryLabel,
  };
};

export const getSidebarUserInitials = (displayName: string): string => {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  const characters = words.length > 1
    ? [Array.from(words[0] ?? '')[0], Array.from(words.at(-1) ?? '')[0]]
    : Array.from(words[0]?.split('@')[0] ?? '').slice(0, 2);
  return characters.filter(Boolean).join('').toLocaleUpperCase() || '?';
};

const requestOptions = (signal: AbortSignal): RequestInit => ({
  credentials: 'include',
  headers: { Accept: 'application/json' },
  cache: 'no-store',
  signal,
});

export const fetchSidebarUserProfile = async (signal: AbortSignal): Promise<SidebarUserProfileResult> => {
  const statusResponse = await runtimeFetch('/auth/ad/status', requestOptions(signal));
  if (!statusResponse.ok) return { status: 'unavailable' };
  const statusPayload = await statusResponse.json().catch(() => null);
  const adEnabled = adEnabledStatusSchema.safeParse(statusPayload).success;
  if (!adEnabled) return { status: 'unavailable' };

  const response = await runtimeFetch('/auth/ad/profile', {
    ...requestOptions(signal),
  });
  if (!response.ok) {
    if (response.status === 409) return { status: 'reauth-required' };
    return response.status === 400 || response.status === 401 || response.status === 404
      ? { status: 'auth-required' }
      : { status: 'unavailable' };
  }

  const profile = parseSidebarUserProfile(await response.json().catch(() => null));
  return profile ? { status: 'ready', profile } : { status: 'auth-required' };
};

export const shouldRequestSidebarProfileLogin = (
  result: SidebarUserProfileResult,
  requireProfileSession: boolean,
): boolean => result.status === 'reauth-required' || (result.status === 'auth-required' && requireProfileSession);

export const logoutSidebarUserProfile = async (signal: AbortSignal): Promise<boolean> => {
  const response = await runtimeFetch('/auth/session', {
    ...requestOptions(signal),
    method: 'DELETE',
  });
  return response.ok;
};

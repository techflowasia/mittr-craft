import { runtimeFetch } from '@/lib/runtime-fetch';

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
  | { status: 'auth-required' | 'unavailable' };

const readTrimmedString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

export const parseSidebarUserProfile = (value: unknown): SidebarUserProfile | null => {
  if (!value || typeof value !== 'object') return null;
  const profileValue = (value as { profile?: unknown }).profile;
  if (!profileValue || typeof profileValue !== 'object') return null;

  const profile = profileValue as Record<string, unknown>;
  const displayName = readTrimmedString(profile.displayName);
  const username = readTrimmedString(profile.username);
  const email = readTrimmedString(profile.email);
  const department = readTrimmedString(profile.department);
  const title = readTrimmedString(profile.title);
  const groups = Array.isArray(profile.groups)
    ? profile.groups.map(readTrimmedString).filter((group): group is string => Boolean(group))
    : [];
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
  const statusPayload: unknown = await statusResponse.json().catch(() => null);
  const adEnabled = Boolean(
    statusPayload
    && typeof statusPayload === 'object'
    && !Array.isArray(statusPayload)
    && (statusPayload as { enabled?: unknown }).enabled === true,
  );
  if (!adEnabled) return { status: 'unavailable' };

  const response = await runtimeFetch('/auth/ad/profile', {
    ...requestOptions(signal),
  });
  if (!response.ok) {
    return response.status === 400 || response.status === 401 || response.status === 404
      ? { status: 'auth-required' }
      : { status: 'unavailable' };
  }

  const profile = parseSidebarUserProfile(await response.json().catch(() => null));
  return profile ? { status: 'ready', profile } : { status: 'auth-required' };
};

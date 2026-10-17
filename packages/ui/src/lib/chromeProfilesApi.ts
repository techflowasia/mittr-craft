import { runtimeFetch } from './runtime-fetch';

export type ChromeProfile = { directory: string; name: string };
export type ChromeProfileResult = {
  status: 'ready' | 'permission_required' | 'unavailable';
  profiles: ChromeProfile[];
};

export const fetchChromeProfiles = async (): Promise<ChromeProfileResult> => {
  const response = await runtimeFetch('/api/mittrcraft/chrome/profiles');
  if (!response.ok) throw new Error('Could not load Chrome profiles');
  const parsed = await response.json().catch(() => null);
  const statuses = ['ready', 'permission_required', 'unavailable'];
  if (!parsed || !statuses.includes(parsed.status) || !Array.isArray(parsed.profiles)) {
    throw new Error('Invalid Chrome profile response');
  }
  const profiles = parsed.profiles.map((profile: unknown): ChromeProfile => {
    if (
      typeof profile !== 'object'
      || profile === null
      || typeof (profile as ChromeProfile).directory !== 'string'
      || typeof (profile as ChromeProfile).name !== 'string'
    ) {
      throw new Error('Invalid Chrome profile entry');
    }
    return { directory: (profile as ChromeProfile).directory, name: (profile as ChromeProfile).name };
  });
  return { status: parsed.status, profiles };
};

export const removeChromeApprovedHost = async (host: string): Promise<string[] | null> => {
  const response = await runtimeFetch(`/api/mittrcraft/chrome/approved-hosts/${encodeURIComponent(host)}`, { method: 'DELETE' });
  if (!response.ok) return null;
  const parsed = await response.json().catch(() => null);
  return Array.isArray(parsed?.hosts) ? (parsed.hosts as string[]) : null;
};

import { runtimeFetch } from './runtime-fetch';

export type ChromeProfile = { directory: string; name: string };

export const fetchChromeProfiles = async (): Promise<ChromeProfile[]> => {
  const response = await runtimeFetch('/api/mittrcraft/chrome/profiles');
  if (!response.ok) return [];
  const parsed = await response.json().catch(() => null);
  return Array.isArray(parsed?.profiles) ? (parsed.profiles as ChromeProfile[]) : [];
};

export const removeChromeApprovedHost = async (host: string): Promise<string[] | null> => {
  const response = await runtimeFetch(`/api/mittrcraft/chrome/approved-hosts/${encodeURIComponent(host)}`, { method: 'DELETE' });
  if (!response.ok) return null;
  const parsed = await response.json().catch(() => null);
  return Array.isArray(parsed?.hosts) ? (parsed.hosts as string[]) : null;
};

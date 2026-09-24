import { runtimeFetch } from './runtime-fetch';

export type ChromeProfile = { directory: string; name: string };

export const fetchChromeProfiles = async (): Promise<ChromeProfile[]> => {
  const response = await runtimeFetch('/api/mittrcraft/chrome/profiles');
  if (!response.ok) return [];
  const parsed = await response.json().catch(() => null);
  return Array.isArray(parsed?.profiles) ? (parsed.profiles as ChromeProfile[]) : [];
};

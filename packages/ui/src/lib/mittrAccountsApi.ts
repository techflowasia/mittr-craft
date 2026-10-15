import { runtimeFetch } from './runtime-fetch';

export type MittrAccount = {
  userId: string;
  displayName: string;
  active: boolean;
};

export type MittrAccountStatus = {
  signedIn: boolean;
  userId?: string;
  displayName?: string;
};

const asAccount = (value: unknown): MittrAccount | null => {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.userId !== 'string' || !entry.userId) return null;
  return {
    userId: entry.userId,
    displayName: typeof entry.displayName === 'string' ? entry.displayName : '',
    active: entry.active === true,
  };
};

export const parseMittrAccounts = (payload: unknown): MittrAccount[] => {
  const list = (payload as { accounts?: unknown })?.accounts;
  if (!Array.isArray(list)) return [];
  return list.map(asAccount).filter((account): account is MittrAccount => account !== null);
};

export const fetchMittrAccounts = async (): Promise<MittrAccount[]> => {
  const response = await runtimeFetch('/api/mittr/auth/accounts');
  if (!response.ok) return [];
  return parseMittrAccounts(await response.json().catch(() => null));
};

export const activateMittrAccount = async (userId: string): Promise<MittrAccountStatus> => {
  const response = await runtimeFetch('/api/mittr/auth/accounts/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

export const signOutActiveMittrAccount = async (): Promise<MittrAccountStatus> => {
  const response = await runtimeFetch('/api/mittr/auth/session', { method: 'DELETE' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

export const startMittrAccountSignIn = async (): Promise<boolean> => {
  const response = await runtimeFetch('/api/mittr/auth/start', { method: 'POST' });
  const payload = await response.json().catch(() => null);
  const url = typeof payload?.authorizeUrl === 'string' ? payload.authorizeUrl : '';
  if (!response.ok || !url) return false;
  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
};

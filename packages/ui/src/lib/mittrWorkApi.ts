import { runtimeFetch } from './runtime-fetch';

export type MittrWorkItem = {
  id: string;
  title: string;
  project: string;
  phase: string | null;
  state: string;
  priority: string | null;
  due: string | null;
  estimate: string | null;
  url: string;
  updatedAt: string;
  source?: 'plane' | 'jira';
};

export type MittrWorkResult = {
  configured: boolean;
  items: MittrWorkItem[];
};

const parseErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed.error === 'string' && parsed.error.trim().length > 0) {
      return parsed.error;
    }
  } catch {
    return fallback;
  }
  return fallback;
};

export const fetchMittrWork = async (): Promise<MittrWorkResult> => {
  const response = await runtimeFetch('/api/mittr/work');
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to load work items'));
  }
  const parsed = await response.json().catch(() => null);
  const items = Array.isArray(parsed?.items) ? (parsed.items as MittrWorkItem[]) : [];
  const configured = parsed?.configured !== false;
  return { configured, items };
};

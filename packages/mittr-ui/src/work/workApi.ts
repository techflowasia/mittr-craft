import type { JsonValue } from '@openchamber/sdk';
import { z } from 'zod';

import { runtimeFetch } from '../../../ui/src/lib/runtime-fetch';
import { mittrT } from '../strings/mittrT';
import type { WorkItem } from './workItems';

export const WORK_ENDPOINT = '/api/mittr/work';

export type MyWorkReply = { configured: boolean; items: WorkItem[]; userId: string | null };

export type WorkResponse = { ok: boolean; json: () => Promise<JsonValue> };
export type WorkFetch = (path: string) => Promise<WorkResponse>;

const optionalText = z.string().nullable().catch(null);

const workItemPayload = z.object({
  id: z.string().min(1),
  title: z.string(),
  project: z.string().catch(''),
  phase: optionalText,
  state: z.string().catch(''),
  priority: optionalText,
  due: optionalText,
  estimate: optionalText,
  url: z.string().catch(''),
  updatedAt: z.string().catch(''),
  source: z.enum(['plane', 'jira']).optional().catch(undefined),
  key: z.string().nullable().optional().catch(undefined),
  workspace: z.string().nullable().optional().catch(undefined),
});

const replyPayload = z.object({
  configured: z.boolean(),
  items: z.array(workItemPayload.nullable().catch(null)),
  userId: z.string().nullable(),
});

const errorPayload = z.object({ error: z.string().refine((text) => text.trim().length > 0) });

const failureText = async (response: WorkResponse): Promise<string> => {
  try {
    const parsed = errorPayload.safeParse(await response.json());
    return parsed.success ? parsed.data.error : mittrT('mittr.work.error');
  } catch {
    return mittrT('mittr.work.error');
  }
};

const readReply = async (response: WorkResponse): Promise<MyWorkReply | null> => {
  try {
    const parsed = replyPayload.safeParse(await response.json());
    if (!parsed.success) return null;
    const { configured, items, userId } = parsed.data;
    return { configured, items: items.flatMap((item) => (item ? [item] : [])), userId };
  } catch {
    return null;
  }
};

export async function fetchMyWork(fetchImpl: WorkFetch = runtimeFetch): Promise<MyWorkReply> {
  let response: WorkResponse;
  try {
    response = await fetchImpl(WORK_ENDPOINT);
  } catch {
    throw new Error(mittrT('mittr.work.error'));
  }
  if (!response.ok) throw new Error(await failureText(response));
  const reply = await readReply(response);
  if (!reply) throw new Error(mittrT('mittr.work.error'));
  return reply;
}

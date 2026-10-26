import type { JsonValue } from '@openchamber/sdk';
import { z } from 'zod';

const errorPayload = z.object({ error: z.string().refine((text) => text.trim().length > 0) });

export const readJsonReply = async (response: { json: () => Promise<JsonValue> }): Promise<JsonValue | undefined> => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

export const errorTextOf = (body: JsonValue | undefined, fallback: string): string => {
  const parsed = errorPayload.safeParse(body);
  return parsed.success ? parsed.data.error : fallback;
};

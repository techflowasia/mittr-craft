import { z } from 'zod';

const structuredResponse = z.object({ response: z.object({ body: z.string() }) });
const lengthLimitBody = z.object({ error: z.object({ code: z.literal('response_length_limit') }) });

export type StructuredResponseError = z.infer<typeof structuredResponse>;

export function isResponseLengthLimit(error: unknown): error is StructuredResponseError {
  const parsed = structuredResponse.safeParse(error);
  if (!parsed.success) return false;
  try {
    return lengthLimitBody.safeParse(JSON.parse(parsed.data.response.body)).success;
  } catch {
    return false;
  }
}

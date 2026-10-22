import type { JsonValue } from '@openchamber/sdk';
import { z } from 'zod';

import { runtimeFetch } from '../../../ui/src/lib/runtime-fetch';
import { errorTextOf, readJsonReply } from '../errorReply';
import { mittrT } from '../strings/mittrT';

export const CHAT_SETTINGS_ENDPOINT = '/api/mittr/chat/settings';

export const SUGGESTION_STYLES = ['next-step', 'unfinished-only'] as const;

const settingsPayload = z.object({
  suggestionStyle: z.enum(SUGGESTION_STYLES),
  canChange: z.boolean(),
});

export type SuggestionStyleSettings = z.infer<typeof settingsPayload>;

export type SuggestionStyle = SuggestionStyleSettings['suggestionStyle'];

type SuggestionStyleResponse = { ok: boolean; status: number; json: () => Promise<JsonValue> };

export type SuggestionStyleFetch = (
  path: string,
  init?: { method: string; headers?: Record<string, string>; body?: string },
) => Promise<SuggestionStyleResponse>;

export type SuggestionStyleApi = {
  load(): Promise<SuggestionStyleSettings>;
  save(style: SuggestionStyle): Promise<SuggestionStyleSettings>;
};

export class SuggestionStyleRequestError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'SuggestionStyleRequestError';
    this.status = status;
  }
}

export function createSuggestionStyleApi(fetchImpl: SuggestionStyleFetch = runtimeFetch): SuggestionStyleApi {
  const request = async (init: Parameters<SuggestionStyleFetch>[1], fallback: string): Promise<SuggestionStyleSettings> => {
    let response: SuggestionStyleResponse;
    try {
      response = await fetchImpl(CHAT_SETTINGS_ENDPOINT, init);
    } catch {
      throw new SuggestionStyleRequestError(fallback, null);
    }
    const body = await readJsonReply(response);
    if (!response.ok) throw new SuggestionStyleRequestError(errorTextOf(body, fallback), response.status);
    const parsed = settingsPayload.safeParse(body);
    if (!parsed.success) throw new SuggestionStyleRequestError(fallback, response.status);
    return parsed.data;
  };

  return {
    load: () => request({ method: 'GET' }, mittrT('mittr.chat.suggestions.errors.loadFailed')),
    save: (style) => request(
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ suggestionStyle: style }) },
      mittrT('mittr.chat.suggestions.errors.saveFailed'),
    ),
  };
}

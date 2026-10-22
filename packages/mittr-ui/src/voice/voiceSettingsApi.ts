import type { JsonValue } from '@openchamber/sdk';
import { z } from 'zod';

import { runtimeFetch } from '../../../ui/src/lib/runtime-fetch';
import { errorTextOf, readJsonReply } from '../errorReply';
import { mittrT } from '../strings/mittrT';

export const VOICE_SETTINGS_ENDPOINT = '/api/mittr/voice/settings';

export const STEP_CAP_RANGE = { min: 1, max: 20, step: 1 } as const;
export const REPLY_MAX_CHARS_RANGE = { min: 1000, max: 30000, step: 500 } as const;

const limitsPayload = z.object({
  stepCap: z.number().int(),
  replyMaxChars: z.number().int(),
  canChange: z.boolean(),
});

export type VoiceLimits = z.infer<typeof limitsPayload>;

export type VoiceLimitsPatch = { stepCap?: number; replyMaxChars?: number };

type VoiceSettingsResponse = { ok: boolean; status: number; json: () => Promise<JsonValue> };

export type VoiceSettingsFetch = (
  path: string,
  init?: { method: string; headers?: Record<string, string>; body?: string },
) => Promise<VoiceSettingsResponse>;

export type VoiceSettingsApi = {
  load(): Promise<VoiceLimits>;
  save(patch: VoiceLimitsPatch): Promise<VoiceLimits>;
};

export class VoiceSettingsRequestError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'VoiceSettingsRequestError';
    this.status = status;
  }
}

export function createVoiceSettingsApi(fetchImpl: VoiceSettingsFetch = runtimeFetch): VoiceSettingsApi {
  const request = async (init: Parameters<VoiceSettingsFetch>[1], fallback: string): Promise<VoiceLimits> => {
    let response: VoiceSettingsResponse;
    try {
      response = await fetchImpl(VOICE_SETTINGS_ENDPOINT, init);
    } catch {
      throw new VoiceSettingsRequestError(fallback, null);
    }
    const body = await readJsonReply(response);
    if (!response.ok) throw new VoiceSettingsRequestError(errorTextOf(body, fallback), response.status);
    const parsed = limitsPayload.safeParse(body);
    if (!parsed.success) throw new VoiceSettingsRequestError(fallback, response.status);
    return parsed.data;
  };

  return {
    load: () => request({ method: 'GET' }, mittrT('mittr.voice.settings.errors.loadFailed')),
    save: (patch) => request(
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) },
      mittrT('mittr.voice.settings.errors.saveFailed'),
    ),
  };
}

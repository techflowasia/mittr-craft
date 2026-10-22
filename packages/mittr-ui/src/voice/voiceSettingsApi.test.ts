import type { JsonValue } from '@openchamber/sdk';
import { describe, expect, test } from 'bun:test';

import { mittrT } from '../strings/mittrT';
import { createVoiceSettingsApi, REPLY_MAX_CHARS_RANGE, STEP_CAP_RANGE, VoiceSettingsRequestError, type VoiceSettingsFetch } from './voiceSettingsApi';

type Call = { path: string; method: string; body: JsonValue | null };

const respond = (status: number, body: JsonValue | 'not json') => {
  const calls: Call[] = [];
  const fetchImpl: VoiceSettingsFetch = async (path, init) => {
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === 'not json') throw new SyntaxError('bad json');
        return body;
      },
    };
  };
  return { api: createVoiceSettingsApi(fetchImpl), calls };
};

const LIMITS = { stepCap: 8, replyMaxChars: 8000, canChange: true };

const refusedWith = async (work: Promise<object>, message: string, status: number | null) => {
  const error = await work.then(() => null, (caught: Error) => caught);
  expect(error).toBeInstanceOf(VoiceSettingsRequestError);
  expect(error?.message).toBe(message);
  expect(error instanceof VoiceSettingsRequestError ? error.status : undefined).toBe(status);
};

describe('MittrCraft voice settings API', () => {
  test('the limits are read from the voice settings route', async () => {
    const { api, calls } = respond(200, LIMITS);
    expect(await api.load()).toEqual(LIMITS);
    expect(calls).toEqual([{ path: '/api/mittr/voice/settings', method: 'GET', body: null }]);
  });

  test('a change is sent as one PUT and answers the stored limits', async () => {
    const { api, calls } = respond(200, { ...LIMITS, stepCap: 12 });
    expect(await api.save({ stepCap: 12 })).toEqual({ ...LIMITS, stepCap: 12 });
    expect(calls).toEqual([{ path: '/api/mittr/voice/settings', method: 'PUT', body: { stepCap: 12 } }]);
  });

  test('a reply that is not the limits shape is a failure, never empty limits', async () => {
    await refusedWith(respond(200, { stepCap: 8 }).api.load(), mittrT('mittr.voice.settings.errors.loadFailed'), 200);
    await refusedWith(respond(200, { ...LIMITS, stepCap: 'eight' }).api.load(), mittrT('mittr.voice.settings.errors.loadFailed'), 200);
    await refusedWith(respond(200, 'not json').api.load(), mittrT('mittr.voice.settings.errors.loadFailed'), 200);
    await refusedWith(respond(400, { error: 'Unknown or invalid voice setting: stepCap' }).api.save({ stepCap: 99 }), 'Unknown or invalid voice setting: stepCap', 400);
    await refusedWith(respond(500, 'not json').api.save({ stepCap: 3 }), mittrT('mittr.voice.settings.errors.saveFailed'), 500);
    const offline: VoiceSettingsFetch = async () => { throw new TypeError('network down'); };
    await refusedWith(createVoiceSettingsApi(offline).save({ stepCap: 3 }), mittrT('mittr.voice.settings.errors.saveFailed'), null);
    await refusedWith(createVoiceSettingsApi(offline).load(), mittrT('mittr.voice.settings.errors.loadFailed'), null);
  });

  test('the limits carry 1.22\'s ranges, which the server enforces', () => {
    expect(STEP_CAP_RANGE).toEqual({ min: 1, max: 20, step: 1 });
    expect(REPLY_MAX_CHARS_RANGE).toEqual({ min: 1000, max: 30000, step: 500 });
  });
});

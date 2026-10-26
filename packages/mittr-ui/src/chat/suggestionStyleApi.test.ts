import type { JsonValue } from '@openchamber/sdk';
import { describe, expect, test } from 'bun:test';

import { mittrT } from '../strings/mittrT';
import { createSuggestionStyleApi, SuggestionStyleRequestError, type SuggestionStyleFetch } from './suggestionStyleApi';

type Call = { path: string; method: string; body: JsonValue | null };

const respond = (status: number, body: JsonValue | 'not json') => {
  const calls: Call[] = [];
  const fetchImpl: SuggestionStyleFetch = async (path, init) => {
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
  return { api: createSuggestionStyleApi(fetchImpl), calls };
};

const refusedWith = async (work: Promise<object>, message: string, status: number | null) => {
  const error = await work.then(() => null, (caught: Error) => caught);
  expect(error).toBeInstanceOf(SuggestionStyleRequestError);
  expect(error?.message).toBe(message);
  expect(error instanceof SuggestionStyleRequestError ? error.status : undefined).toBe(status);
};

describe('MittrCraft suggestion style API', () => {
  test('the style is read from the chat settings route', async () => {
    const { api, calls } = respond(200, { suggestionStyle: 'next-step', canChange: true });
    expect(await api.load()).toEqual({ suggestionStyle: 'next-step', canChange: true });
    expect(calls).toEqual([{ path: '/api/mittr/chat/settings', method: 'GET', body: null }]);
  });

  test('a change is one PUT of the style and answers what was stored', async () => {
    const { api, calls } = respond(200, { suggestionStyle: 'unfinished-only', canChange: true });
    expect(await api.save('unfinished-only')).toEqual({ suggestionStyle: 'unfinished-only', canChange: true });
    expect(calls).toEqual([{ path: '/api/mittr/chat/settings', method: 'PUT', body: { suggestionStyle: 'unfinished-only' } }]);
  });

  test('a reply that is not the settings shape, an error or no answer is a failure', async () => {
    await refusedWith(respond(200, { suggestionStyle: 'always', canChange: true }).api.load(), mittrT('mittr.chat.suggestions.errors.loadFailed'), 200);
    await refusedWith(respond(200, { suggestionStyle: 'next-step' }).api.load(), mittrT('mittr.chat.suggestions.errors.loadFailed'), 200);
    await refusedWith(respond(200, 'not json').api.load(), mittrT('mittr.chat.suggestions.errors.loadFailed'), 200);
    await refusedWith(respond(403, { error: 'These settings can be changed only on this Mac' }).api.save('next-step'), 'These settings can be changed only on this Mac', 403);
    await refusedWith(respond(500, 'not json').api.save('next-step'), mittrT('mittr.chat.suggestions.errors.saveFailed'), 500);
    const offline: SuggestionStyleFetch = async () => { throw new TypeError('network down'); };
    await refusedWith(createSuggestionStyleApi(offline).load(), mittrT('mittr.chat.suggestions.errors.loadFailed'), null);
    await refusedWith(createSuggestionStyleApi(offline).save('next-step'), mittrT('mittr.chat.suggestions.errors.saveFailed'), null);
  });
});

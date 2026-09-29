import { beforeEach, describe, expect, mock, test } from 'bun:test';

let replies: unknown[] = [];
let calls = 0;

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async () => {
    calls += 1;
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next), { headers: { 'content-type': 'application/json' } });
  },
}));

const { readMittrVoiceReadiness, forgetMittrVoiceReadiness } = await import('./useMittrVoiceReadiness');

const ready = { listen: true, speak: true, voice: true, signedIn: true, voiceSilenceMs: 900, reason: null };
const signedOut = { listen: false, speak: false, voice: false, signedIn: false, voiceSilenceMs: null, reason: 'not_signed_in' };

beforeEach(() => {
  replies = [];
  calls = 0;
  forgetMittrVoiceReadiness();
});

describe('readMittrVoiceReadiness', () => {
  test('never keeps a not-ready answer, so signing in is seen at once', async () => {
    replies = [signedOut, ready];
    expect((await readMittrVoiceReadiness())?.reason).toBe('not_signed_in');
    expect((await readMittrVoiceReadiness())?.speak).toBe(true);
    expect(calls).toBe(2);
  });

  test('keeps a ready answer for a while', async () => {
    replies = [ready, signedOut];
    await readMittrVoiceReadiness();
    expect((await readMittrVoiceReadiness())?.speak).toBe(true);
    expect(calls).toBe(1);
  });

  test('a failed read is unknown, not ready, and is asked again', async () => {
    replies = [new TypeError('offline'), ready];
    expect(await readMittrVoiceReadiness()).toBeNull();
    expect((await readMittrVoiceReadiness())?.speak).toBe(true);
  });
});

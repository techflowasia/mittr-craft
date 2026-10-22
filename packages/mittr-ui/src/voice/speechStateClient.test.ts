import { describe, expect, test } from 'bun:test';

import { speechBlockedUntil, speechQuotaStore } from './speechQuotaStore';
import { SPEECH_STATE_ENDPOINT, startSpeechStateClient, type SpeechStateView } from './speechStateClient';
import type { VoiceFetch } from './voiceApi';

const RESETS_AT = '2099-10-26T17:00:00.000Z';

const view = (revision: number, stt: string | null, tts: string | null = null): SpeechStateView => ({
  revision,
  stt: { blockedUntil: stt },
  tts: { blockedUntil: tts },
});

function longPoll(answers: (SpeechStateView | 'fail')[]) {
  const paths: string[] = [];
  let release: () => void = () => {};
  const idle = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch: VoiceFetch = async (input, init) => {
    paths.push(input);
    const next = answers.shift();
    if (next === 'fail') return new Response('down', { status: 502 });
    if (next) return new Response(JSON.stringify(next), { headers: { 'content-type': 'application/json' } });
    release();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  };
  return { fetch, paths, idle };
}

describe('the speech state client', () => {
  test('a block from the server state disables voice input until it lifts', async () => {
    speechQuotaStore.reset();
    const poll = longPoll([view(1, RESETS_AT), view(2, null)]);
    const seen: (string | null)[] = [];
    const stopWatching = speechQuotaStore.subscribe(() => seen.push(speechBlockedUntil('stt')));
    const stop = startSpeechStateClient({ fetch: poll.fetch });
    await poll.idle;
    stop();
    stopWatching();
    expect(seen).toEqual([RESETS_AT, null]);
    expect(poll.paths).toEqual([SPEECH_STATE_ENDPOINT, `${SPEECH_STATE_ENDPOINT}?since=1`, `${SPEECH_STATE_ENDPOINT}?since=2`]);
  });

  test('a failed read waits and asks again from the same revision', async () => {
    const blocks: string[] = [];
    const waits: number[] = [];
    const poll = longPoll([view(4, null, RESETS_AT), 'fail', view(5, null, null)]);
    const stop = startSpeechStateClient({
      fetch: poll.fetch,
      retryMs: 7,
      wait: async (ms) => {
        waits.push(ms);
      },
      blocks: {
        block: (kind, resetsAt) => {
          blocks.push(`block ${kind} ${resetsAt}`);
          return resetsAt ?? '';
        },
        clear: (kind) => {
          blocks.push(`clear ${kind}`);
        },
      },
    });
    await poll.idle;
    stop();
    expect(waits).toEqual([7]);
    expect(poll.paths.slice(1, 3)).toEqual([`${SPEECH_STATE_ENDPOINT}?since=4`, `${SPEECH_STATE_ENDPOINT}?since=4`]);
    expect(blocks).toEqual(['clear stt', `block tts ${RESETS_AT}`, 'clear stt', 'clear tts']);
  });
});

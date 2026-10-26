import { describe, expect, test } from 'bun:test';

import type { MessageQueueTarget } from '../../../ui/src/stores/messageQueueStore';
import { composerQueue, queueSpokenPrompt, queuedPromptCount, type SpokenPrompt, type SpokenPromptQueue } from './queue';
import type { VoiceQueueEvent } from './voiceApi';

const sendConfig = { providerID: 'mittr', modelID: 'acme-writer', agent: 'build', variant: 'high' };

function fakeQueue(options: { refuse?: boolean } = {}) {
  const added: { target: MessageQueueTarget; prompt: SpokenPrompt }[] = [];
  const queue: SpokenPromptQueue = {
    target: (sessionId, directory) => (sessionId && directory ? { runtimeKey: 'acme-runtime', directory, sessionId } : null),
    add: async (target, prompt) => {
      if (options.refuse) throw new Error('A queued message needs a provider and model to be delivered later.');
      added.push({ target, prompt });
    },
    count: (target) => added.filter((entry) => entry.target.sessionId === target.sessionId).length,
  };
  return { queue, added };
}

const event = (patch: Partial<VoiceQueueEvent> = {}): VoiceQueueEvent => ({
  sessionId: 's1',
  directory: '/repo',
  text: 'run the tests',
  sendConfig,
  ...patch,
});

describe('queueSpokenPrompt', () => {
  test('the queue event adds one entry with that send config', async () => {
    const fake = fakeQueue();
    expect(await queueSpokenPrompt(event({ text: '  run the tests ' }), fake.queue)).toBe(true);
    expect(fake.added).toEqual([
      { target: { runtimeKey: 'acme-runtime', directory: '/repo', sessionId: 's1' }, prompt: { content: 'run the tests', sendConfig } },
    ]);
  });

  test('nothing is queued without a session, a directory or text', async () => {
    const fake = fakeQueue();
    expect(await queueSpokenPrompt(event({ sessionId: '' }), fake.queue)).toBe(false);
    expect(await queueSpokenPrompt(event({ directory: '' }), fake.queue)).toBe(false);
    expect(await queueSpokenPrompt(event({ text: '  ' }), fake.queue)).toBe(false);
    expect(fake.added).toHaveLength(0);
  });

  test('a refused add answers false instead of throwing', async () => {
    const fake = fakeQueue({ refuse: true });
    expect(await queueSpokenPrompt(event(), fake.queue)).toBe(false);
  });

  test("upstream's server-owned queue refuses a prompt with no send config, and nothing is left queued", async () => {
    expect(await queueSpokenPrompt(event({ sendConfig: null, directory: '/acme' }))).toBe(false);
    expect(queuedPromptCount('s1', '/acme')).toBe(0);
  });

  test("upstream's queue has no target without a directory", () => {
    expect(composerQueue.target('s1', '')).toBeNull();
  });
});

describe('queuedPromptCount', () => {
  test('counts the queue of the open session and is unknown without one', async () => {
    const fake = fakeQueue();
    await queueSpokenPrompt(event({ text: 'one' }), fake.queue);
    await queueSpokenPrompt(event({ text: 'two' }), fake.queue);
    expect(queuedPromptCount('s1', '/repo', fake.queue)).toBe(2);
    expect(queuedPromptCount('s2', '/repo', fake.queue)).toBe(0);
    expect(queuedPromptCount(null, '/repo', fake.queue)).toBe(undefined);
    expect(queuedPromptCount('s1', null, fake.queue)).toBe(undefined);
  });
});

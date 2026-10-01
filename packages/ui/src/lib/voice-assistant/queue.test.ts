import { beforeEach, describe, expect, test } from 'bun:test';
import { createMessageQueueTarget, useMessageQueueStore } from '@/stores/messageQueueStore';
import { queueSpokenPrompt, queuedPromptCount } from './queue';

const sendConfig = { providerID: 'mittr', modelID: 'gpt-6-luna', agent: 'build', variant: undefined };

beforeEach(() => {
  useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
});

describe('queueSpokenPrompt', () => {
  test('a queue event lands exactly one queued message for that target, with the send config of the moment', () => {
    const queued = queueSpokenPrompt({ sessionId: 's1', directory: '/repo', text: 'run the tests' }, { readSendConfig: () => sendConfig, viewedSessionId: 's1' });
    expect(queued).toBe(true);
    const target = createMessageQueueTarget('s1', '/repo')!;
    const queue = useMessageQueueStore.getState().getQueueForTarget(target);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.content).toBe('run the tests');
    expect(queue[0]?.sendConfig).toEqual(sendConfig);
    expect(Object.keys(useMessageQueueStore.getState().queuedMessages)).toHaveLength(1);
  });

  test('a prompt for a session that is not on screen carries no send config', () => {
    queueSpokenPrompt({ sessionId: 's2', directory: '/repo', text: 'run the tests' }, { readSendConfig: () => sendConfig, viewedSessionId: 's1' });
    const queue = useMessageQueueStore.getState().getQueueForTarget(createMessageQueueTarget('s2', '/repo')!);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.sendConfig).toBe(undefined);
  });

  test('nothing is queued without a session, a directory or text', () => {
    expect(queueSpokenPrompt({ sessionId: '', directory: '/repo', text: 'x' }, { readSendConfig: () => sendConfig, viewedSessionId: 's1' })).toBe(false);
    expect(queueSpokenPrompt({ sessionId: 's1', directory: '', text: 'x' }, { readSendConfig: () => sendConfig, viewedSessionId: 's1' })).toBe(false);
    expect(queueSpokenPrompt({ sessionId: 's1', directory: '/repo', text: '  ' }, { readSendConfig: () => sendConfig, viewedSessionId: 's1' })).toBe(false);
    expect(Object.keys(useMessageQueueStore.getState().queuedMessages)).toHaveLength(0);
  });
});

describe('queuedPromptCount', () => {
  test('counts the queue of the open session and is unknown without one', () => {
    queueSpokenPrompt({ sessionId: 's1', directory: '/repo', text: 'one' }, { readSendConfig: () => undefined, viewedSessionId: 's1' });
    queueSpokenPrompt({ sessionId: 's1', directory: '/repo', text: 'two' }, { readSendConfig: () => undefined, viewedSessionId: 's1' });
    expect(queuedPromptCount('s1', '/repo')).toBe(2);
    expect(queuedPromptCount('s2', '/repo')).toBe(0);
    expect(queuedPromptCount(null, '/repo')).toBe(undefined);
    expect(queuedPromptCount('s1', null)).toBe(undefined);
  });
});

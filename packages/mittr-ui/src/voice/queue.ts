import {
  createMessageQueueTarget,
  useMessageQueueStore,
  type MessageQueueTarget,
  type QueuedMessageSendConfig,
} from '../../../ui/src/stores/messageQueueStore';
import { QUEUED_PROMPTS_LIMIT, type VoiceQueueEvent } from './voiceApi';

export type SpokenPrompt = { content: string; sendConfig?: QueuedMessageSendConfig };

export interface SpokenPromptQueue {
  target(sessionId: string, directory: string): MessageQueueTarget | null;
  add(target: MessageQueueTarget, prompt: SpokenPrompt): Promise<void>;
  count(target: MessageQueueTarget): number;
}

export const composerQueue: SpokenPromptQueue = {
  target: (sessionId, directory) => createMessageQueueTarget(sessionId, directory),
  add: (target, prompt) => useMessageQueueStore.getState().addToQueue(target, prompt),
  count: (target) => useMessageQueueStore.getState().getQueueForTarget(target).length,
};

export async function queueSpokenPrompt(event: VoiceQueueEvent, queue: SpokenPromptQueue = composerQueue): Promise<boolean> {
  const content = event.text.trim();
  const target = queue.target(event.sessionId, event.directory);
  if (!target || !content) return false;
  const prompt: SpokenPrompt = event.sendConfig ? { content, sendConfig: event.sendConfig } : { content };
  try {
    await queue.add(target, prompt);
    return true;
  } catch {
    return false;
  }
}

export function queuedPromptCount(
  sessionId: string | null | undefined,
  directory: string | null | undefined,
  queue: SpokenPromptQueue = composerQueue,
): number | undefined {
  if (!sessionId || !directory) return undefined;
  const target = queue.target(sessionId, directory);
  if (!target) return undefined;
  return Math.min(QUEUED_PROMPTS_LIMIT, queue.count(target));
}

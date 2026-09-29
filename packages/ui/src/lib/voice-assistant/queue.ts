import { createMessageQueueTarget, useMessageQueueStore, type QueuedMessage } from '@/stores/messageQueueStore';
import { useConfigStore } from '@/stores/useConfigStore';
import type { VoiceQueueEvent } from './turn';

type SendConfig = QueuedMessage['sendConfig'];

export const QUEUED_PROMPTS_LIMIT = 1000;

export function currentSendConfig(): SendConfig {
  const { currentProviderId, currentModelId, currentAgentName, currentVariant } = useConfigStore.getState();
  return currentProviderId && currentModelId
    ? {
        providerID: currentProviderId,
        modelID: currentModelId,
        agent: currentAgentName ?? undefined,
        variant: currentVariant ?? undefined,
      }
    : undefined;
}

export function queueSpokenPrompt(event: VoiceQueueEvent, readSendConfig: () => SendConfig = currentSendConfig): boolean {
  const content = event.text.trim();
  const target = createMessageQueueTarget(event.sessionId, event.directory);
  if (!target || !content) return false;
  useMessageQueueStore.getState().addToQueue(target, { content, sendConfig: readSendConfig() });
  return true;
}

export function queuedPromptCount(sessionId: string | null | undefined, directory: string | null | undefined): number | undefined {
  if (!sessionId || !directory) return undefined;
  const target = createMessageQueueTarget(sessionId, directory);
  if (!target) return undefined;
  return Math.min(QUEUED_PROMPTS_LIMIT, useMessageQueueStore.getState().getQueueForTarget(target).length);
}

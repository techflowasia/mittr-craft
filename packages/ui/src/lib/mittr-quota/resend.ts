import type { Message } from '@opencode-ai/sdk/v2';

import { useSessionUIStore } from '@/sync/session-ui-store';
import { getDirectoryState } from '@/sync/sync-refs';
import { resendAfterQuota } from './retry';

export function resendQuotaPrompt(assistant: Message): Promise<boolean> {
  return resendAfterQuota(assistant, {
    readTurn: (sessionId, userMessageId) => {
      const directory = useSessionUIStore.getState().getDirectoryForSession(sessionId) ?? undefined;
      const state = getDirectoryState(directory);
      return {
        directory,
        user: state?.message[sessionId]?.find((message) => message.id === userMessageId),
        userParts: state?.part[userMessageId] ?? [],
      };
    },
    send: (prompt) =>
      useSessionUIStore.getState().sendMessage(
        prompt.text,
        prompt.providerID,
        prompt.modelID,
        prompt.agent,
        undefined,
        undefined,
        undefined,
        prompt.variant,
        'normal',
        { sessionId: prompt.sessionId, ...(prompt.directory ? { directory: prompt.directory } : {}) },
      ),
  });
}

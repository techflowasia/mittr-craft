import type { Message } from '@opencode-ai/sdk/v2';
import { create } from 'zustand';

import type { AttachedFile } from '@/stores/types/sessionTypes';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getDirectoryState } from '@/sync/sync-refs';
import { resendAfterQuota, type QuotaRetryDeps, type QuotaRetryFile, type QuotaRetryPrompt } from './retry';

type SendMessage = ReturnType<typeof useSessionUIStore.getState>['sendMessage'];

export const useQuotaRetryPending = create<{ pending: Record<string, true> }>(() => ({ pending: {} }));

const setPending = (messageId: string, pending: boolean) => {
  useQuotaRetryPending.setState((state) => {
    const next = { ...state.pending };
    if (pending) next[messageId] = true;
    else delete next[messageId];
    return { pending: next };
  });
};

const toAttachment = (file: QuotaRetryFile, index: number): AttachedFile => ({
  id: `quota-retry-${index}`,
  file: new File([], file.filename, { type: file.mime }),
  dataUrl: file.url,
  mimeType: file.mime,
  filename: file.filename,
  size: 0,
  source: 'server',
});

export function sendQuotaRetryPrompt(prompt: QuotaRetryPrompt, sendMessage: SendMessage): Promise<void> {
  return sendMessage(
    prompt.text,
    prompt.providerID,
    prompt.modelID,
    prompt.agent,
    prompt.files.map(toAttachment),
    prompt.agentMentionName,
    prompt.syntheticTexts.map((value) => ({ text: value, synthetic: true })),
    prompt.variant,
    'normal',
    { sessionId: prompt.sessionId, ...(prompt.directory ? { directory: prompt.directory } : {}) },
  );
}

const storeDeps: QuotaRetryDeps = {
  readTurn: (sessionId, userMessageId) => {
    const directory = useSessionUIStore.getState().getDirectoryForSession(sessionId) ?? undefined;
    const state = getDirectoryState(directory);
    return {
      directory,
      user: state?.message[sessionId]?.find((message) => message.id === userMessageId),
      userParts: state?.part[userMessageId] ?? [],
    };
  },
  send: (prompt) => sendQuotaRetryPrompt(prompt, useSessionUIStore.getState().sendMessage),
};

export async function resendQuotaPrompt(assistant: Message, deps: QuotaRetryDeps = storeDeps): Promise<boolean> {
  if (useQuotaRetryPending.getState().pending[assistant.id]) return false;
  setPending(assistant.id, true);
  try {
    return await resendAfterQuota(assistant, deps);
  } catch {
    return false;
  } finally {
    setPending(assistant.id, false);
  }
}

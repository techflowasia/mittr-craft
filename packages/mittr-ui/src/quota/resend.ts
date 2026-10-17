import type { AssistantMessage, Message, Part } from '../../../ui/src/lib/opencode/model';
import type { AttachedFile } from '../../../ui/src/stores/types/sessionTypes';
import { useSessionUIStore } from '../../../ui/src/sync/session-ui-store';
import { getSyncMessages, getSyncParts } from '../../../ui/src/sync/sync-refs';

export type QuotaRetryFile = { url: string; mime: string; filename: string };

export type QuotaRetryPrompt = {
  sessionId: string;
  directory?: string;
  text: string;
  files: QuotaRetryFile[];
  syntheticTexts: string[];
  providerID: string;
  modelID: string;
  agent?: string;
  agentMentionName?: string;
  variant?: string;
};

export type QuotaRetryTurn = {
  directory?: string;
  messages: readonly Message[];
  partsOf: (messageId: string) => readonly Part[];
};

export type QuotaRetryDeps = {
  readTurn: (assistant: AssistantMessage) => QuotaRetryTurn | null;
  send: (prompt: QuotaRetryPrompt) => Promise<void>;
  pending: Set<string>;
};

type SendMessage = ReturnType<typeof useSessionUIStore.getState>['sendMessage'];

const isConversation = (record: Message): boolean => record.role === 'user' || record.role === 'assistant';

const syntheticTextsBefore = (messages: readonly Message[], userIndex: number): string[] => {
  const texts: string[] = [];
  for (let index = userIndex - 1; index >= 0; index -= 1) {
    const record = messages[index];
    if (isConversation(record)) break;
    if (record.role === 'synthetic' && record.text.trim()) texts.unshift(record.text);
  }
  return texts;
};

function buildQuotaRetryPrompt(assistant: AssistantMessage, turn: QuotaRetryTurn): QuotaRetryPrompt | null {
  const assistantIndex = turn.messages.findIndex((record) => record.id === assistant.id);
  let userIndex = assistantIndex - 1;
  while (userIndex >= 0 && turn.messages[userIndex].role !== 'user') userIndex -= 1;
  if (userIndex < 0) return null;

  const typed: string[] = [];
  const files: QuotaRetryFile[] = [];
  let agentMentionName: string | undefined;
  for (const part of turn.partsOf(turn.messages[userIndex].id)) {
    if (part.type === 'text') typed.push(part.text);
    else if (part.type === 'file') files.push({ url: part.url, mime: part.mime, filename: part.filename ?? '' });
    else if (part.type === 'agent') agentMentionName ??= part.name;
  }
  const text = typed.join('\n').trim();
  if (!text && files.length === 0) return null;

  const prompt: QuotaRetryPrompt = {
    sessionId: assistant.sessionID,
    text,
    files,
    syntheticTexts: syntheticTextsBefore(turn.messages, userIndex),
    providerID: assistant.providerID,
    modelID: assistant.modelID,
  };
  if (turn.directory) prompt.directory = turn.directory;
  if (assistant.agent) prompt.agent = assistant.agent;
  if (agentMentionName) prompt.agentMentionName = agentMentionName;
  if (assistant.variant) prompt.variant = assistant.variant;
  return prompt;
}

export async function resendAfterQuota(assistant: AssistantMessage, { readTurn, send, pending }: QuotaRetryDeps): Promise<boolean> {
  if (pending.has(assistant.id)) return false;
  pending.add(assistant.id);
  try {
    const turn = readTurn(assistant);
    const prompt = turn ? buildQuotaRetryPrompt(assistant, turn) : null;
    if (!prompt) return false;
    await send(prompt);
    return true;
  } catch {
    return false;
  } finally {
    pending.delete(assistant.id);
  }
}

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
    prompt.syntheticTexts.map((text) => ({ text, synthetic: true })),
    prompt.variant,
    'normal',
    { sessionId: prompt.sessionId, directory: prompt.directory },
  );
}

const readStoreTurn = (assistant: AssistantMessage): QuotaRetryTurn => {
  const directory = useSessionUIStore.getState().getDirectoryForSession(assistant.sessionID) ?? undefined;
  return {
    directory,
    messages: getSyncMessages(assistant.sessionID, directory),
    partsOf: (messageId) => getSyncParts(messageId, directory),
  };
};

export const sessionQuotaRetryDeps = (pending: Set<string>): QuotaRetryDeps => ({
  readTurn: readStoreTurn,
  send: (prompt) => sendQuotaRetryPrompt(prompt, useSessionUIStore.getState().sendMessage),
  pending,
});

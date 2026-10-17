import { opencodeClient, type FileInputLite } from '../../../ui/src/lib/opencode/client';
import type { AssistantMessage, Message, Part } from '../../../ui/src/lib/opencode/model';
import { resolveSendSelection, useSessionUIStore } from '../../../ui/src/sync/session-ui-store';
import { getSyncMessages, getSyncParts } from '../../../ui/src/sync/sync-refs';

export type QuotaRetryPrompt = {
  sessionId: string;
  directory?: string;
  text: string;
  files: FileInputLite[];
  context: Array<{ text: string; description?: string }>;
  agentMentions: Array<{ name: string }>;
  providerID: string;
  modelID: string;
  variant?: string;
  agent?: string;
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

const contextBefore = (messages: readonly Message[], userIndex: number): QuotaRetryPrompt['context'] => {
  const context: QuotaRetryPrompt['context'] = [];
  for (let index = userIndex - 1; index >= 0; index -= 1) {
    const record = messages[index];
    if (record.role !== 'synthetic') break;
    if (!record.text.trim()) continue;
    context.unshift(record.description ? { text: record.text, description: record.description } : { text: record.text });
  }
  return context;
};

function buildQuotaRetryPrompt(assistant: AssistantMessage, turn: QuotaRetryTurn): QuotaRetryPrompt | null {
  const assistantIndex = turn.messages.findIndex((record) => record.id === assistant.id);
  let userIndex = assistantIndex - 1;
  while (userIndex >= 0 && turn.messages[userIndex].role !== 'user') userIndex -= 1;
  if (userIndex < 0) return null;

  const typed: string[] = [];
  const files: FileInputLite[] = [];
  const agentMentions: QuotaRetryPrompt['agentMentions'] = [];
  for (const part of turn.partsOf(turn.messages[userIndex].id)) {
    if (part.type === 'text') typed.push(part.text);
    else if (part.type === 'file') {
      const file: FileInputLite = { type: 'file', mime: part.mime, url: part.url };
      if (part.filename) file.filename = part.filename;
      files.push(file);
    } else if (part.type === 'agent') agentMentions.push({ name: part.name });
  }
  const text = typed.join('\n').trim();
  if (!text && files.length === 0) return null;

  const prompt: QuotaRetryPrompt = {
    sessionId: assistant.sessionID,
    text,
    files,
    context: contextBefore(turn.messages, userIndex),
    agentMentions,
    providerID: assistant.providerID,
    modelID: assistant.modelID,
  };
  if (turn.directory) prompt.directory = turn.directory;
  if (assistant.variant) prompt.variant = assistant.variant;
  if (assistant.agent) prompt.agent = assistant.agent;
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

const readStoreTurn = (assistant: AssistantMessage): QuotaRetryTurn => {
  const directory = useSessionUIStore.getState().getDirectoryForSession(assistant.sessionID) ?? undefined;
  return {
    directory,
    messages: getSyncMessages(assistant.sessionID, directory),
    partsOf: (messageId) => getSyncParts(messageId, directory),
  };
};

const sendThroughClient = async (prompt: QuotaRetryPrompt): Promise<void> => {
  const selection = resolveSendSelection(prompt.sessionId, prompt.directory, {
    providerID: prompt.providerID,
    modelID: prompt.modelID,
    variant: prompt.variant,
    agent: prompt.agent,
  });
  await opencodeClient.sendMessage({
    id: prompt.sessionId,
    providerID: prompt.providerID,
    model: selection.model,
    agent: selection.agent,
    text: prompt.text,
    files: prompt.files,
    context: prompt.context.length > 0 ? prompt.context : undefined,
    agentMentions: prompt.agentMentions.length > 0 ? prompt.agentMentions : undefined,
    directory: prompt.directory,
  });
};

export const sessionQuotaRetryDeps = (pending: Set<string>): QuotaRetryDeps => ({
  readTurn: readStoreTurn,
  send: sendThroughClient,
  pending,
});

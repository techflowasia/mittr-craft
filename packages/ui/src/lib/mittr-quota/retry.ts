import type { Message, Part } from '@opencode-ai/sdk/v2';

export interface QuotaRetryPrompt {
  sessionId: string;
  directory?: string;
  text: string;
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
}

interface QuotaRetryTurn {
  directory?: string;
  user: Message | undefined;
  userParts: readonly Part[];
}

export interface QuotaRetryDeps {
  readTurn: (sessionId: string, userMessageId: string) => QuotaRetryTurn;
  send: (prompt: QuotaRetryPrompt) => Promise<void>;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

function buildQuotaRetryPrompt(assistant: Message, turn: QuotaRetryTurn): QuotaRetryPrompt | null {
  if (assistant.role !== 'assistant') return null;
  const user = turn.user?.role === 'user' ? turn.user : undefined;
  const prompt = turn.userParts
    .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text' && !part.synthetic && !part.ignored)
    .map((part) => part.text)
    .join('\n')
    .trim();
  if (!prompt) return null;
  const providerID = text(user?.model?.providerID) ?? text(assistant.providerID);
  const modelID = text(user?.model?.modelID) ?? text(assistant.modelID);
  if (!providerID || !modelID) return null;
  const agent = text(user?.agent) ?? text(assistant.mode);
  const variant = text(user?.model?.variant);
  return {
    sessionId: assistant.sessionID,
    ...(turn.directory ? { directory: turn.directory } : {}),
    text: prompt,
    providerID,
    modelID,
    ...(agent ? { agent } : {}),
    ...(variant ? { variant } : {}),
  };
}

export async function resendAfterQuota(assistant: Message, deps: QuotaRetryDeps): Promise<boolean> {
  if (assistant.role !== 'assistant' || !assistant.parentID) return false;
  const prompt = buildQuotaRetryPrompt(assistant, deps.readTurn(assistant.sessionID, assistant.parentID));
  if (!prompt) return false;
  await deps.send(prompt);
  return true;
}

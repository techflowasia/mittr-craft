import type { Message, Part } from '@opencode-ai/sdk/v2';

export interface QuotaRetryFile {
  url: string;
  mime: string;
  filename: string;
}

export interface QuotaRetryPrompt {
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

function rebuildParts(parts: readonly Part[]) {
  const typed: string[] = [];
  const files: QuotaRetryFile[] = [];
  const syntheticTexts: string[] = [];
  let run: string[] = [];
  let agentMentionName: string | undefined;
  let afterAgent = false;

  for (const part of parts) {
    if (part.type === 'text') {
      if (part.ignored) continue;
      if (!part.synthetic) {
        syntheticTexts.push(...run);
        run = [];
        typed.push(part.text);
      } else if (afterAgent) {
        afterAgent = false;
      } else {
        run.push(part.text);
      }
      continue;
    }
    afterAgent = false;
    if (part.type === 'file') {
      run = [];
      files.push({ url: part.url, mime: part.mime, filename: part.filename ?? '' });
    } else if (part.type === 'agent') {
      syntheticTexts.push(...run);
      run = [];
      agentMentionName = part.name;
      afterAgent = true;
    }
  }
  syntheticTexts.push(...run);
  return {
    text: typed.join('\n').trim(),
    files,
    syntheticTexts: syntheticTexts.filter((value) => value.trim()),
    agentMentionName,
  };
}

function buildQuotaRetryPrompt(assistant: Message, turn: QuotaRetryTurn): QuotaRetryPrompt | null {
  if (assistant.role !== 'assistant') return null;
  const user = turn.user?.role === 'user' ? turn.user : undefined;
  const rebuilt = rebuildParts(turn.userParts);
  if (!rebuilt.text && rebuilt.files.length === 0) return null;
  const providerID = text(user?.model?.providerID) ?? text(assistant.providerID);
  const modelID = text(user?.model?.modelID) ?? text(assistant.modelID);
  if (!providerID || !modelID) return null;
  const agent = text(user?.agent) ?? text(assistant.mode);
  const variant = text(user?.model?.variant);
  return {
    sessionId: assistant.sessionID,
    ...(turn.directory ? { directory: turn.directory } : {}),
    text: rebuilt.text,
    files: rebuilt.files,
    syntheticTexts: rebuilt.syntheticTexts,
    providerID,
    modelID,
    ...(agent ? { agent } : {}),
    ...(rebuilt.agentMentionName ? { agentMentionName: rebuilt.agentMentionName } : {}),
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

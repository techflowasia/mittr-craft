import { deriveMessageRole } from '@/components/chat/message/messageRole';
import type { JsonValue, Message, Metadata, Part } from '@/lib/opencode/model';
import { isSubagentTool } from '@/lib/opencode/tools';
import {
  deriveMessageLabel,
  formatStepDuration,
  groupIntoTurns,
  withDayHeadings,
  type ActivityTurn,
  type MessageLabel,
} from './rawMessagePreview';

export type SessionMessage = { info: Message; parts: Part[] };

export type ChildSession = { id: string; title?: string };

export type TokenCounts = { input: number; output: number };

const sessionIdIn = (value: JsonValue | undefined): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const sessionIdOf = (record: Metadata | undefined): string | undefined => (
  record ? sessionIdIn(record.sessionID) ?? sessionIdIn(record.sessionId) : undefined
);

export const readSpawnedSessionIds = (message: SessionMessage): string[] => {
  const ids: string[] = [];
  for (const part of message.parts) {
    if (part.type !== 'tool' || !isSubagentTool(part.tool)) continue;
    const id = sessionIdOf(part.state.status === 'pending' ? undefined : part.state.metadata) ?? sessionIdIn(part.state.input.sessionID);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
};

const nonNegative = (value: number | undefined): number => (
  value !== undefined && Number.isFinite(value) && value > 0 ? value : 0
);

export const readTokenCounts = (message: SessionMessage): TokenCounts | null => {
  const { info } = message;
  if (info.role !== 'assistant' || !info.tokens) return null;
  return { input: nonNegative(info.tokens.input), output: nonNegative(info.tokens.output) };
};

export const readCreated = (message: SessionMessage): number | null => message.info.time.created ?? null;

const readCompleted = (message: SessionMessage): number | null => {
  const { info } = message;
  return info.role === 'assistant' || info.role === 'shell' ? info.time.completed ?? null : null;
};

export const stepTiming = (message: SessionMessage) => {
  const created = readCreated(message);
  const completed = readCompleted(message);
  const { info } = message;
  const running = info.role === 'shell'
    ? info.status === 'running'
    : info.role === 'assistant' && created !== null && completed === null;
  return { running, duration: running ? null : formatStepDuration(created, completed) };
};

export const stepLabel = (message: SessionMessage): MessageLabel => {
  const label = deriveMessageLabel(message.parts);
  return label.primary ? label : { primary: message.info.role, ambient: '' };
};

export type TimelineTurn = { item: ActivityTurn<SessionMessage>; dayHeading: number | null };

const isPrompt = (message: SessionMessage): boolean => deriveMessageRole(message.info).role === 'user';

export const timelineTurns = (messages: readonly SessionMessage[]): TimelineTurn[] => withDayHeadings(
  [...groupIntoTurns(messages.filter((message) => message.info.role !== 'idle'), isPrompt)].reverse(),
  (turn) => {
    const anchor = turn.prompt ?? turn.steps[0]?.message ?? null;
    return anchor ? readCreated(anchor) : null;
  },
);

export const orphanChildren = (messages: readonly SessionMessage[], children: readonly ChildSession[]): ChildSession[] => {
  const claimed = new Set(messages.flatMap(readSpawnedSessionIds));
  return children.filter((child) => !claimed.has(child.id));
};

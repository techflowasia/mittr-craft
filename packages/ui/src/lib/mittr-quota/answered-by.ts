import type { AssistantMessage, Message } from '@opencode-ai/sdk/v2';

import { MITTR_PROVIDER_ID } from './quota-me-store';

export type AnsweredByReason = 'quota' | 'failed' | 'silent';

export interface AnsweredBy {
  at: number;
  model: string;
  reason: AnsweredByReason;
  requestedLabel: string;
  answeredLabel: string;
}

export interface AnsweredByList {
  now: number;
  answers: AnsweredBy[];
}

export interface AnsweredMessage {
  modelID: string;
  created: number;
  completed: number;
}

type AnsweredByFetch = (input: string, init?: RequestInit) => Promise<Response>;

const REASONS: ReadonlySet<string> = new Set<AnsweredByReason>(['quota', 'failed', 'silent']);

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isLabel = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const readAnswer = (value: unknown): AnsweredBy | null => {
  if (!value || typeof value !== 'object') return null;
  const answer = value as Record<string, unknown>;
  if (!isTime(answer.at) || !isLabel(answer.model)) return null;
  if (!isLabel(answer.requestedLabel) || !isLabel(answer.answeredLabel)) return null;
  if (typeof answer.reason !== 'string' || !REASONS.has(answer.reason)) return null;
  return {
    at: answer.at,
    model: answer.model,
    reason: answer.reason as AnsweredByReason,
    requestedLabel: answer.requestedLabel,
    answeredLabel: answer.answeredLabel,
  };
};

export function parseAnsweredByList(value: unknown): AnsweredByList | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (!isTime(body.now) || !Array.isArray(body.answers)) return null;
  return {
    now: body.now,
    answers: body.answers.map(readAnswer).filter((answer): answer is AnsweredBy => answer !== null),
  };
}

export async function fetchAnsweredBy(fetchImpl: AnsweredByFetch, sessionId: string): Promise<AnsweredByList> {
  const response = await fetchImpl(`/api/mittr/answered-by?sessionId=${encodeURIComponent(sessionId)}`, { method: 'GET' });
  if (!response.ok) throw new Error(`answered-by read failed with ${response.status}`);
  const list = parseAnsweredByList(await response.json().catch(() => null));
  if (!list) throw new Error('answered-by read returned an unreadable body');
  return list;
}

export function answeredByFor(answers: readonly AnsweredBy[], message: AnsweredMessage): AnsweredBy | null {
  for (let index = answers.length - 1; index >= 0; index -= 1) {
    const answer = answers[index];
    if (answer.model === message.modelID && answer.at >= message.created && answer.at <= message.completed) {
      return answer;
    }
  }
  return null;
}

export const isMittrAnswer = (message: Message): message is AssistantMessage => (
  message.role === 'assistant' && message.providerID === MITTR_PROVIDER_ID
);

export function substitutedAnswerOf(message: Message, list: AnsweredByList | undefined): AnsweredBy | null {
  if (!list || !isMittrAnswer(message) || message.time.completed === undefined) return null;
  return answeredByFor(list.answers, {
    modelID: message.modelID,
    created: message.time.created,
    completed: message.time.completed,
  });
}

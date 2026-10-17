import React from 'react';

import type { Message } from '../../../ui/src/lib/opencode/model';
import { runtimeFetch } from '../../../ui/src/lib/runtime-fetch';

export const ANSWERED_BY_ENDPOINT = '/api/mittr/answered-by';
export const ANSWERED_BY_RETRY_MS = 30_000;

const MITTR_PROVIDER_ID = 'mittr';

export type AnsweredByReason = 'quota' | 'failed' | 'silent';

export type AnsweredBy = {
  at: number;
  model: string;
  reason: AnsweredByReason;
  requestedLabel: string;
  answeredLabel: string;
};

export type AnsweredByList = { now: number; answers: AnsweredBy[] };

export type AnsweredMessage = { modelID: string; created: number; completed: number };

export type AnsweredByResponse = { ok: boolean; json: () => Promise<unknown> };
export type AnsweredByFetch = (path: string) => Promise<AnsweredByResponse>;

const REASONS: ReadonlySet<string> = new Set<AnsweredByReason>(['quota', 'failed', 'silent']);

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isLabel = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function readAnswer(value: unknown): AnsweredBy | null {
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
}

export function parseAnsweredByList(value: unknown): AnsweredByList | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (!isTime(body.now) || !Array.isArray(body.answers)) return null;
  return {
    now: body.now,
    answers: body.answers.map(readAnswer).filter((answer): answer is AnsweredBy => answer !== null),
  };
}

export function answeredByFor(answers: readonly AnsweredBy[], message: AnsweredMessage): AnsweredBy | null {
  for (let index = answers.length - 1; index >= 0; index -= 1) {
    const answer = answers[index];
    if (answer.model === message.modelID && answer.at >= message.created && answer.at <= message.completed) return answer;
  }
  return null;
}

export function substitutedAnswerOf(info: Message, list: AnsweredByList | undefined): AnsweredBy | null {
  if (!list || info.role !== 'assistant' || info.providerID !== MITTR_PROVIDER_ID || info.time.completed === undefined) return null;
  return answeredByFor(list.answers, { modelID: info.modelID, created: info.time.created, completed: info.time.completed });
}

export type AnsweredByController = {
  snapshot: (sessionId: string) => AnsweredByList | undefined;
  subscribe: (listener: () => void) => () => void;
  load: (sessionId: string, completedAt: number) => Promise<void>;
};

export function createAnsweredByController({ fetch, now = Date.now }: { fetch: AnsweredByFetch; now?: () => number }): AnsweredByController {
  const lists = new Map<string, AnsweredByList>();
  const pending = new Map<string, Promise<void>>();
  const failedAt = new Map<string, number>();
  const listeners = new Set<() => void>();

  const read = async (sessionId: string): Promise<AnsweredByList | null> => {
    try {
      const response = await fetch(`${ANSWERED_BY_ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`);
      if (!response.ok) return null;
      return parseAnsweredByList(await response.json());
    } catch {
      return null;
    }
  };

  const load = (sessionId: string, completedAt: number): Promise<void> => {
    const inFlight = pending.get(sessionId);
    if (inFlight) return inFlight;
    const known = lists.get(sessionId);
    if (known && known.now >= completedAt) return Promise.resolve();
    const failed = failedAt.get(sessionId);
    if (failed !== undefined && now() - failed < ANSWERED_BY_RETRY_MS) return Promise.resolve();
    const request = read(sessionId)
      .then((list) => {
        if (!list) {
          failedAt.set(sessionId, now());
          return;
        }
        failedAt.delete(sessionId);
        lists.set(sessionId, list);
        for (const listener of listeners) listener();
      })
      .finally(() => {
        pending.delete(sessionId);
      });
    pending.set(sessionId, request);
    return request;
  };

  return {
    snapshot: (sessionId) => lists.get(sessionId),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load,
  };
}

let shared: AnsweredByController | null = null;

const sharedController = (): AnsweredByController => {
  shared ??= createAnsweredByController({ fetch: (path) => runtimeFetch(path) });
  return shared;
};

export function useAnsweredBy(sessionId: string, completedAt: number): AnsweredByList | undefined {
  const controller = sharedController();
  const list = React.useSyncExternalStore(
    controller.subscribe,
    () => controller.snapshot(sessionId),
    () => controller.snapshot(sessionId),
  );
  React.useEffect(() => {
    void controller.load(sessionId, completedAt);
  }, [controller, sessionId, completedAt]);
  return list;
}

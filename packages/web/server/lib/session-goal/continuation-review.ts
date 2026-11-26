import { z } from 'zod';

export interface ContinuationReviewInput {
  sessionId: string;
  directory: string;
  goalId: string;
  resumed: boolean;
}

export interface ContinuationReview {
  block: string;
  note: string;
}

export interface GoalEnd {
  sessionId: string;
  directory: string;
  reason: 'complete' | 'cleared';
}

export type GoalEndListener = (input: GoalEnd) => Promise<void> | void;

export type ContinuationReviewer = (input: ContinuationReviewInput) => Promise<Partial<ContinuationReview> | null | undefined> | Partial<ContinuationReview> | null | undefined;

const REVIEW_TIMEOUT_MS = 30_000;
const NO_REVIEW: ContinuationReview = { block: '', note: '' };

const answerSchema = z.object({ block: z.string().optional(), note: z.string().optional() }).nullish();

export const createContinuationReview = (reviewer: ContinuationReviewer | null, timeoutMs = REVIEW_TIMEOUT_MS) => {
  const running = new Set<string>();
  return async (input: ContinuationReviewInput): Promise<ContinuationReview> => {
    if (!reviewer) return NO_REVIEW;
    if (running.has(input.sessionId)) {
      console.warn('[session-goal] continuation review skipped: the previous one is still running');
      return NO_REVIEW;
    }
    running.add(input.sessionId);
    const asked = (async () => reviewer(input))();
    void asked.catch(() => undefined).finally(() => running.delete(input.sessionId));
    return settleReview(asked, timeoutMs);
  };
};

const settleReview = async (asked: ReturnType<ContinuationReviewer>, timeoutMs: number): Promise<ContinuationReview> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    const answer = answerSchema.parse(await Promise.race([asked, timeout]));
    return { block: answer?.block?.trim() ?? '', note: answer?.note?.trim() ?? '' };
  } catch (error) {
    console.warn('[session-goal] continuation review failed:', error instanceof Error ? error.message : error);
    return NO_REVIEW;
  } finally {
    clearTimeout(timer);
  }
};

export const announceGoalEnd = (listener: GoalEndListener | null, input: GoalEnd) => {
  if (!listener) return;
  void (async () => {
    try {
      await listener(input);
    } catch (error) {
      console.warn('[session-goal] goal end listener failed:', error instanceof Error ? error.message : error);
    }
  })();
};

import { randomUUID } from 'node:crypto';

const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'function_call', 'content_filter']);
const OUTCOMES = new Set(['length', 'http_error', 'transport_error', 'stream_error', 'timeout', 'quota', 'upstream_error', 'client_closed', 'not_signed_in', 'account_changed']);

/** Select metadata only. Never retain bodies, headers, identifiers or error text. */
export const createRequestMetadata = ({ body, now, logger }) => {
  const record = {
    requestId: randomUUID(),
    startedAt: now(),
    elapsedMs: null,
    maxTokens: count(body.max_tokens),
    maxCompletionTokens: count(body.max_completion_tokens),
    httpStatus: null,
    finishReason: null,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cachedInputTokens: null,
    usageAvailable: false,
    outcome: null,
  };
  let emitted = false;
  return {
    setStatus(status) {
      record.httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    },
    observe(frame) {
      if (Array.isArray(frame?.choices)) {
        for (const choice of frame.choices) {
          if (choice?.finish_reason == null) continue;
          record.finishReason = FINISH_REASONS.has(choice.finish_reason) ? choice.finish_reason : 'unknown';
          if (record.finishReason === 'length') break;
        }
      }
      const usage = frame?.usage;
      if (!usage) return;
      const selected = {
        inputTokens: count(usage.prompt_tokens),
        outputTokens: count(usage.completion_tokens),
        reasoningTokens: count(usage.completion_tokens_details?.reasoning_tokens),
        cachedInputTokens: count(usage.prompt_tokens_details?.cached_tokens),
      };
      for (const [key, value] of Object.entries(selected)) {
        if (value !== null) {
          record[key] = value;
          record.usageAvailable = true;
        }
      }
    },
    fail(outcome) {
      if (emitted) return;
      emitted = true;
      record.outcome = OUTCOMES.has(outcome) ? outcome : 'unknown';
      record.elapsedMs = count(Math.max(0, now() - record.startedAt));
      try {
        logger.log(`[mittr] request-failed ${JSON.stringify(record)}`);
      } catch {
        // Diagnostics must not interrupt an answer or retry logging its contents.
      }
    },
  };
};

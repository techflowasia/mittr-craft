import { describe, expect, test } from 'bun:test';

import { quotaExhaustedFromMessageError, readQuotaExhausted } from './exhausted';

const RESETS_AT = '2026-10-04T17:00:00.000Z';

const envelope = {
  error: { type: 'insufficient_quota', code: 'llm_quota_exhausted', message: 'โควตาหมด', resets_at: RESETS_AT, model: 'MITTR 2.0' },
};

const flat = { code: 'llm_quota_exhausted', modelKey: 'asr', kind: 'stt', label: 'Voice', resetsAt: RESETS_AT, message: 'โควตาหมด' };

describe('readQuotaExhausted', () => {
  test('reads the chat completions envelope', () => {
    expect(readQuotaExhausted(envelope)).toEqual({ kind: 'chat', resetsAt: RESETS_AT });
  });

  test('reads the flat platform body with its kind', () => {
    expect(readQuotaExhausted(flat)).toEqual({ kind: 'stt', resetsAt: RESETS_AT });
    expect(readQuotaExhausted(JSON.stringify({ ...flat, kind: 'tts' }))).toEqual({ kind: 'tts', resetsAt: RESETS_AT });
  });

  test('keeps an exhaustion without a readable reset time', () => {
    expect(readQuotaExhausted({ code: 'llm_quota_exhausted' })).toEqual({ kind: 'chat', resetsAt: null });
  });

  test('ignores ordinary rate limits and other errors', () => {
    expect(readQuotaExhausted({ error: { type: 'rate_limit_exceeded', message: 'Too many requests' } })).toBeNull();
    expect(readQuotaExhausted({ error: { type: 'insufficient_quota', message: 'billing' } })).toBeNull();
    expect(readQuotaExhausted({ code: 'upstream_failed' })).toBeNull();
    expect(readQuotaExhausted('Too Many Requests')).toBeNull();
    expect(readQuotaExhausted(undefined)).toBeNull();
  });
});

describe('quotaExhaustedFromMessageError', () => {
  test('finds the quota in the engine error that a refused request leaves', () => {
    const error = {
      name: 'APIError',
      data: { message: 'โควตาหมด', statusCode: 402, isRetryable: false, responseBody: JSON.stringify(envelope) },
    };
    expect(quotaExhaustedFromMessageError(error)).toEqual({ kind: 'chat', resetsAt: RESETS_AT });
  });

  test('finds the quota in the engine error a refused stream leaves', () => {
    const responseBody = JSON.stringify({
      type: 'error',
      error: { type: 'insufficient_quota', code: 'insufficient_quota', reason: 'llm_quota_exhausted', message: 'โควตาหมด', resets_at: RESETS_AT },
    });
    const error = { name: 'APIError', data: { message: 'Quota exceeded. Check your plan and billing details.', isRetryable: false, responseBody } };
    expect(quotaExhaustedFromMessageError(error)).toEqual({ kind: 'chat', resetsAt: RESETS_AT });
  });

  test('says nothing about a retryable rate limit', () => {
    const error = { name: 'APIError', data: { message: 'Too Many Requests', statusCode: 429, isRetryable: true, responseBody: '{"error":{"type":"rate_limit"}}' } };
    expect(quotaExhaustedFromMessageError(error)).toBeNull();
    expect(quotaExhaustedFromMessageError({ name: 'UnknownError', data: { message: 'boom' } })).toBeNull();
  });
});

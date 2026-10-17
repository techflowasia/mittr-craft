import { describe, expect, test } from 'bun:test';

import { translateProductMessageError } from '../../../ui/src/lib/product-plugins';
import '../product-ui-plugin';
import { mittrT } from '../strings/mittrT';
import { formatResetTime, PRODUCT_LOCALE, PRODUCT_TIME_ZONE } from './agentStatus';
import { mittrMessageError, quotaExhaustedFromError, type MessageError } from './quotaError';

const bangkok = (resetsAt: string) => formatResetTime(resetsAt, PRODUCT_LOCALE, PRODUCT_TIME_ZONE);

const RESETS_AT = '2026-10-04T17:00:00.000Z';

const flat = {
  code: 'llm_quota_exhausted',
  modelKey: 'qwen-36',
  kind: 'stt',
  label: 'Voice input',
  resetsAt: RESETS_AT,
  message: 'quota used up',
};

const envelope = {
  error: {
    type: 'insufficient_quota',
    code: 'llm_quota_exhausted',
    message: 'quota used up',
    resets_at: RESETS_AT,
    model: 'MITTR 2.0',
  },
};

const streamInner = JSON.stringify({
  type: 'error',
  error: { type: 'insufficient_quota', code: 'insufficient_quota', reason: 'llm_quota_exhausted', kind: 'chat', resets_at: RESETS_AT },
});

const streamFrame = { error: { type: 'insufficient_quota', code: 'llm_quota_exhausted', message: streamInner } };

const engineError = (responseBody: string | undefined, message = 'Weekly model quota used up', status = 402): MessageError => {
  const error: MessageError = { type: 'provider.quota', message, status };
  if (responseBody !== undefined) error.responseBody = responseBody;
  return error;
};

describe('quotaExhaustedFromError', () => {
  test('reads the chat completions envelope from the response body', () => {
    expect(quotaExhaustedFromError(engineError(JSON.stringify(envelope)))).toEqual({ kind: 'chat', resetsAt: RESETS_AT });
  });

  test('reads the flat platform body with its kind', () => {
    expect(quotaExhaustedFromError(engineError(JSON.stringify(flat)))).toEqual({ kind: 'stt', resetsAt: RESETS_AT });
  });

  test('reads the reset time a mid-stream refusal carries inside the frame', () => {
    expect(quotaExhaustedFromError(engineError(JSON.stringify(streamFrame), 'x', 200))).toEqual({ kind: 'chat', resetsAt: RESETS_AT });
  });

  test('reads the message when the body says nothing', () => {
    expect(quotaExhaustedFromError(engineError(undefined, streamInner, 200))).toEqual({ kind: 'chat', resetsAt: RESETS_AT });
    expect(quotaExhaustedFromError(engineError('<html>bad gateway</html>', JSON.stringify(envelope)))).toEqual({ kind: 'chat', resetsAt: RESETS_AT });
  });

  test('keeps an exhaustion whose reset time is missing or unreadable', () => {
    expect(quotaExhaustedFromError(engineError(JSON.stringify({ code: 'llm_quota_exhausted', resetsAt: 'soon' })))).toEqual({ kind: 'chat', resetsAt: null });
    expect(quotaExhaustedFromError(engineError(JSON.stringify({ error: { code: 'llm_quota_exhausted' } })))).toEqual({ kind: 'chat', resetsAt: null });
  });

  test('never decides on the status or the engine error type alone', () => {
    expect(quotaExhaustedFromError(engineError(undefined, 'Payment required', 402))).toBeNull();
    expect(quotaExhaustedFromError({ type: 'provider.quota', message: 'quota', status: 200 })).toBeNull();
  });

  test('ignores an ordinary rate limit and other refusals', () => {
    expect(quotaExhaustedFromError(engineError(JSON.stringify({ error: { type: 'rate_limit_exceeded', code: 'rate_limit', message: 'slow down' } }), 'slow down', 429))).toBeNull();
    expect(quotaExhaustedFromError(engineError(JSON.stringify({ error: 'agent_not_granted' })))).toBeNull();
    expect(quotaExhaustedFromError(engineError(JSON.stringify({ code: 'upstream_failed' })))).toBeNull();
    expect(quotaExhaustedFromError(engineError('not json', 'not json'))).toBeNull();
  });

  test('does not claim a provider insufficient_quota that carries no reset time', () => {
    const billing = JSON.stringify({ error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'billing' } });
    expect(quotaExhaustedFromError(engineError(billing, 'billing'))).toBeNull();
  });
});

describe('the chat error text', () => {
  test('quota refusal reads as used up with the reset time', () => {
    const error = {
      type: 'APIError',
      message: 'x',
      status: 402,
      responseBody: '{"error":{"code":"llm_quota_exhausted","resets_at":"2026-10-19T17:00:00Z"}}',
    };
    const text = mittrMessageError(error);
    expect(text).toContain('20 Oct');
    expect(text).toContain('00:00');
    expect(text).toBe(mittrT('mittr.quota.exhausted.chat', { when: bangkok('2026-10-19T17:00:00Z') }));
  });

  test('a refusal without a reset time still reads as used up', () => {
    expect(mittrMessageError(engineError(JSON.stringify({ error: { code: 'llm_quota_exhausted' } })))).toBe(mittrT('mittr.quota.exhausted.chatNoReset'));
  });

  test('a turn on a provider the lock keeps off says how to turn it on', () => {
    expect(mittrMessageError({ type: 'provider.no-route', message: 'Model unavailable: other/m1' })).toBe(mittrT('mittr.providers.noRoute'));
  });

  test("other errors keep upstream's text", () => {
    expect(mittrMessageError({ type: 'provider.rate-limit', message: 'Too Many Requests', status: 429 })).toBeNull();
    expect(mittrMessageError({ type: 'APIError', message: 'boom', status: 500, responseBody: '{"error":{"type":"server_error"}}' })).toBeNull();
  });

  test('the registered plugin rewords the chat error', () => {
    expect(translateProductMessageError(engineError(JSON.stringify(envelope)))).toBe(mittrT('mittr.quota.exhausted.chat', { when: bangkok(RESETS_AT) }));
    expect(translateProductMessageError({ type: 'provider.no-route', message: 'Model unavailable: other/m1' })).toBe(mittrT('mittr.providers.noRoute'));
    expect(translateProductMessageError({ type: 'APIError', message: 'boom' })).toBeNull();
  });
});

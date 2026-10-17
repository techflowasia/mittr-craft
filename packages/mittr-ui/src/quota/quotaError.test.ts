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
    expect(mittrMessageError({ type: 'provider.no-route', message: 'Model unavailable: other/m1', providerID: 'other' })).toBe(mittrT('mittr.providers.noRoute'));
    expect(mittrMessageError({ type: 'provider.no-route', message: 'Model unavailable: other/m1' })).toBe(mittrT('mittr.providers.noRoute'));
  });

  test('a Mittr model with no route says to pick another Mittr model', () => {
    const text = mittrMessageError({ type: 'provider.no-route', message: 'Model unavailable: mittr/pm_9', providerID: 'mittr' });
    expect(text).toBe(mittrT('mittr.providers.noRouteMittr'));
    expect(text).toBe("This Mittr model isn't available to you right now. Pick another Mittr model.");
  });

  const refused = (code: string, responseBody?: string): MessageError => ({ type: 'provider.auth', message: code, status: 403, ...(responseBody === undefined ? {} : { responseBody }) });
  const entitlementBody = JSON.stringify({ error: { message: 'desktop_entitlement_required', type: 'invalid_request_error', code: 'forbidden' } });
  const withdrawnBody = JSON.stringify({ error: { message: 'agent_not_granted', type: 'invalid_request_error', code: 'agent_not_granted' } });

  test('the chat says an admin is needed', () => {
    const text = mittrMessageError(refused('desktop_entitlement_required', entitlementBody));
    expect(text).toBe(mittrT('mittr.model.refused.entitlement'));
    expect(text).toBe('Your organisation has not given you MittrCraft access. Ask an admin.');
  });

  test('a withdrawn agent says the list is being refreshed and to pick another', () => {
    const text = mittrMessageError(refused('agent_not_granted', withdrawnBody));
    expect(text).toBe(mittrT('mittr.model.refused.staleCatalog'));
    expect(text).toBe('This agent is no longer available to you. Your model list is being refreshed; pick another.');
  });

  test('the refusal is read from the body the engine stores, the flat string form and the message alone', () => {
    expect(mittrMessageError(refused('x', JSON.stringify({ error: { code: 'agent_not_granted' } })))).toBe(mittrT('mittr.model.refused.staleCatalog'));
    expect(mittrMessageError(refused('x', JSON.stringify({ error: 'desktop_entitlement_required' })))).toBe(mittrT('mittr.model.refused.entitlement'));
    expect(mittrMessageError(refused('agent_not_granted'))).toBe(mittrT('mittr.model.refused.staleCatalog'));
    expect(mittrMessageError(refused('desktop_entitlement_required', '<html>bad gateway</html>'))).toBe(mittrT('mittr.model.refused.entitlement'));
  });

  test('a 403 nobody can name, or a refusal word on another status, keeps upstream text', () => {
    expect(mittrMessageError(refused('Forbidden', JSON.stringify({ error: { message: 'Forbidden', code: 'forbidden' } })))).toBeNull();
    expect(mittrMessageError(refused('agent_not_granted_yet', JSON.stringify({ error: { message: 'agent_not_granted_yet' } })))).toBeNull();
    expect(mittrMessageError({ type: 'provider.auth', message: 'agent_not_granted', status: 401, responseBody: withdrawnBody })).toBeNull();
    expect(mittrMessageError({ type: 'provider.auth', message: 'agent_not_granted' })).toBeNull();
  });

  test('a quota refusal still wins over the refusal reader', () => {
    expect(mittrMessageError(engineError(JSON.stringify(envelope)))).toBe(mittrT('mittr.quota.exhausted.chat', { when: bangkok(RESETS_AT) }));
  });

  const CUT_OFF = JSON.stringify({ error: { type: 'invalid_request_error', code: 'stream_cut_off', message: 'The answer was cut off. Send your message again.' } });

  test('a cut-off answer reads as product text without the engine prefix, and never asks to try again', () => {
    const text = mittrMessageError({ type: 'provider.invalid-request', message: 'The answer was cut off. Send your message again.', status: 200, responseBody: CUT_OFF, providerID: 'mittr' });
    expect(text).toBe(mittrT('mittr.answer.cutOff'));
    expect(text).toBe('The answer was cut off. Send your message again.');
    expect(/try again/i.test(text ?? '')).toBe(false);
    expect(/failed to send message/i.test(text ?? '')).toBe(false);
  });

  test('other invalid-request errors keep upstream text', () => {
    expect(mittrMessageError({ type: 'provider.invalid-request', message: 'bad', status: 400, responseBody: JSON.stringify({ error: { type: 'invalid_request_error', code: 'model_not_found' } }) })).toBeNull();
  });

  test('none of the new texts contains the words that make the engine retry', () => {
    for (const key of ['mittr.model.refused.entitlement', 'mittr.model.refused.staleCatalog', 'mittr.answer.cutOff'] as const) {
      expect(/try again/i.test(mittrT(key))).toBe(false);
    }
  });

  test('the registered plugin rewords the new errors', () => {
    expect(translateProductMessageError(refused('desktop_entitlement_required', entitlementBody))).toBe(mittrT('mittr.model.refused.entitlement'));
    expect(translateProductMessageError(refused('agent_not_granted', withdrawnBody))).toBe(mittrT('mittr.model.refused.staleCatalog'));
    expect(translateProductMessageError({ type: 'provider.invalid-request', message: 'cut', status: 200, responseBody: CUT_OFF })).toBe(mittrT('mittr.answer.cutOff'));
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

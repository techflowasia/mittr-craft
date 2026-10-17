import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { AssistantMessage, Message } from '../../../ui/src/lib/opencode/model';
import { mittrT } from '../strings/mittrT';
import { QuotaRetryButton, QuotaRetryButtonView } from './QuotaRetryButton';

const refusal = {
  type: 'provider.quota',
  message: 'Weekly model quota used up',
  status: 402,
  response: { body: '{"error":{"type":"insufficient_quota","code":"llm_quota_exhausted","resets_at":"2026-10-19T17:00:00.000Z"}}' },
};

const assistant = (error?: AssistantMessage['error']): AssistantMessage => {
  const info: AssistantMessage = {
    id: 'msg_a',
    sessionID: 'ses_1',
    role: 'assistant',
    time: { created: 2 },
    agent: 'build',
    providerID: 'mittr',
    modelID: 'pm_1',
    finish: 'error',
  };
  if (error) info.error = error;
  return info;
};

const render = (info: Message, isLatestTurn: boolean) => renderToStaticMarkup(
  <QuotaRetryButton message={{ info, parts: [] }} isLatestTurn={isLatestTurn} />,
);

describe('quota Try again', () => {
  test('is offered on the latest refused turn', () => {
    const html = render(assistant(refusal), true);
    expect(html).toContain(mittrT('mittr.quota.exhausted.retry'));
    expect(html).toContain('<button');
    expect(html).not.toContain('disabled=""');
  });

  test('Try again shows only on the latest refused turn', () => {
    expect(render(assistant(refusal), false)).toBe('');
  });

  test('is not offered for another error, an answer or a user turn', () => {
    expect(render(assistant({ type: 'provider.rate-limit', message: 'Too Many Requests', status: 429 }), true)).toBe('');
    expect(render(assistant(), true)).toBe('');
    expect(render({ id: 'msg_u', sessionID: 'ses_1', role: 'user', time: { created: 1 } }, true)).toBe('');
  });

  test('is disabled and busy while the resend is pending', () => {
    const html = renderToStaticMarkup(<QuotaRetryButtonView busy onRetry={() => {}} />);
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
  });
});

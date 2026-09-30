import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { AssistantErrorNotice } from './AssistantErrorNotice';
import { QuotaRetryButtonView, isLatestInSession } from './QuotaRetryButton';

const render = (node: React.ReactNode) => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);

describe('quota Try again', () => {
  test('sits in the error notice next to the reset message', () => {
    const html = render(
      <AssistantErrorNotice
        message="Your model quota for this week is used up · resets Mon 5 Oct, 00:00"
        variant="error"
        action={<QuotaRetryButtonView pending={false} onRetry={() => {}} />}
        onShowPopup={() => {}}
      />,
    );
    expect(html).toContain('Try again');
    expect(html).toContain('<button');
    expect(html).not.toContain('disabled=""');
  });

  test('an ordinary error notice has no Try again', () => {
    const html = render(<AssistantErrorNotice message="boom" variant="error" onShowPopup={() => {}} />);
    expect(html).not.toContain('Try again');
  });

  test('is disabled and busy while the resend is pending', () => {
    const html = render(<QuotaRetryButtonView pending onRetry={() => {}} />);
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
  });

  test('is offered only on the latest message of the session, never on a superseded turn', () => {
    const messages = [{ id: 'msg_u1' }, { id: 'msg_a1' }, { id: 'msg_u2' }, { id: 'msg_a2' }];
    expect(isLatestInSession(messages, 'msg_a2')).toBe(true);
    expect(isLatestInSession(messages, 'msg_a1')).toBe(false);
    expect(isLatestInSession([...messages, { id: 'msg_u3' }], 'msg_a2')).toBe(false);
    expect(isLatestInSession([], 'msg_a2')).toBe(false);
  });
});

import React from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '@opencode-ai/sdk/v2';

import { I18nProvider } from '@/lib/i18n';
import { quotaI18n } from '@/lib/i18n/messages/quota.i18n';
import { useAnsweredByStore } from '@/lib/mittr-quota/answered-by-store';
import { substitutedAnswerOf } from '@/lib/mittr-quota/answered-by';
import { AnsweredByNotice, AnsweredByNoticeView } from './AnsweredByNotice';

const render = (node: React.ReactNode) => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);

const assistant = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'msg_a1',
  sessionID: 'ses_1',
  role: 'assistant',
  time: { created: 1000, completed: 2000 },
  parentID: 'msg_u1',
  modelID: 'mittr-1',
  providerID: 'mittr',
  mode: 'build',
  agent: 'build',
  path: { cwd: '/', root: '/' },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ...overrides,
}) as Message;

const ANSWER = {
  at: 1500,
  model: 'mittr-1',
  reason: 'quota' as const,
  requestedLabel: 'MITTR 1.0',
  answeredLabel: 'MittrCraft 1.0',
};

afterEach(() => {
  useAnsweredByStore.setState({ sessions: {} });
});

describe('answered by notice', () => {
  test('names the backup and says the chosen model is out of quota', () => {
    const html = render(<AnsweredByNoticeView answer={ANSWER} />);
    expect(html).toContain('Answered by “MittrCraft 1.0” — “MITTR 1.0” is out of quota this week');
    expect(html).toContain('text-muted-foreground');
    expect(html).not.toContain('status-error');
  });

  test('says the chosen model could not answer when it failed or stayed silent', () => {
    for (const reason of ['failed', 'silent'] as const) {
      const html = render(<AnsweredByNoticeView answer={{ ...ANSWER, reason }} />);
      expect(html).toContain('Answered by “MittrCraft 1.0” — “MITTR 1.0” could not answer');
    }
  });

  test('has the Thai wording', () => {
    expect(quotaI18n.th['quota.answeredBy.outOfQuota']).toBe('ตอบด้วย “{to}” — โควตา “{from}” สัปดาห์นี้หมดแล้ว');
    expect(quotaI18n.th['quota.answeredBy.couldNotAnswer']).toContain('ตอบด้วย “{to}”');
  });

  test('belongs only to the message that was actually substituted', () => {
    const list = { now: 3000, answers: [ANSWER] };
    expect(substitutedAnswerOf(assistant(), list)).toEqual(ANSWER);
    expect(substitutedAnswerOf(assistant({ id: 'msg_a0', time: { created: 100, completed: 900 } }), list)).toBeNull();
    expect(substitutedAnswerOf(assistant({ time: { created: 1000 } }), list)).toBeNull();
    expect(substitutedAnswerOf(assistant({ providerID: 'openai' }), list)).toBeNull();
    expect(substitutedAnswerOf(assistant({ role: 'user' }), list)).toBeNull();
    expect(substitutedAnswerOf(assistant(), undefined)).toBeNull();
  });

  test('shows nothing before the session was read', () => {
    expect(render(<AnsweredByNotice assistant={assistant()} />)).toBe('');
  });
});

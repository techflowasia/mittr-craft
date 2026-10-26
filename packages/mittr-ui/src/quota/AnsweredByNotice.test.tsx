import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Message } from '../../../ui/src/lib/opencode/model';
import { mittrT } from '../strings/mittrT';
import type { AnsweredBy } from './answeredBy';
import { AnsweredByLine, AnsweredByNoticeView } from './AnsweredByNotice';

const ANSWER: AnsweredBy = { at: 1500, model: 'pm_1', reason: 'quota', requestedLabel: 'Writer', answeredLabel: 'Backup' };

const assistant = (over: Record<string, unknown> = {}): Message => ({
  id: 'msg_a',
  sessionID: 'ses_1',
  role: 'assistant',
  time: { created: 1000, completed: 2000 },
  agent: 'build',
  providerID: 'mittr',
  modelID: 'pm_1',
  ...over,
}) as Message;

describe('answered-by notice', () => {
  test('the notice names the backup and the reason', () => {
    const html = renderToStaticMarkup(<AnsweredByNoticeView answer={ANSWER} />);
    expect(html).toContain('Answered by Backup. Writer is used up this week.');
    expect(html).toContain('text-muted-foreground');
    expect(html).not.toContain('status-error');
    expect(html).toContain('data-answered-by="quota"');
  });

  test('a failed or silent agent is named as one that could not answer', () => {
    for (const reason of ['failed', 'silent'] as const) {
      const html = renderToStaticMarkup(<AnsweredByNoticeView answer={{ ...ANSWER, reason }} />);
      expect(html).toContain('Answered by Backup. Writer could not answer.');
    }
  });

  test('the strings are plain English', () => {
    expect(mittrT('mittr.answeredBy.outOfQuota', { to: 'B', from: 'W' })).toBe('Answered by B. W is used up this week.');
    expect(mittrT('mittr.answeredBy.couldNotAnswer', { to: 'B', from: 'W' })).toBe('Answered by B. W could not answer.');
  });

  test('the line belongs only to the message that was substituted', () => {
    const list = { now: 3000, answers: [ANSWER] };
    expect(renderToStaticMarkup(<AnsweredByLine info={assistant()} list={list} />)).toContain('Answered by Backup');
    expect(renderToStaticMarkup(<AnsweredByLine info={assistant({ time: { created: 100, completed: 900 } })} list={list} />)).toBe('');
    expect(renderToStaticMarkup(<AnsweredByLine info={assistant()} list={undefined} />)).toBe('');
  });
});

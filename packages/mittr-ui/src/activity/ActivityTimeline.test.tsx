import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Message, Part } from '@/lib/opencode/model';
import type { SessionMessage } from './activityModel';
import { ActivityTimeline } from './ActivityTimeline';

const info = (data: Record<string, unknown>): Message => data as unknown as Message;
const part = (data: Record<string, unknown>): Part => data as unknown as Part;

const at = new Date(2024, 0, 15, 9, 30).getTime();

const user = (id: string, created: number, text: string): SessionMessage => ({
  info: info({ id, sessionID: 'ses_1', role: 'user', time: { created } }),
  parts: [part({ type: 'text', text })],
});

const assistant = (id: string, created: number, over: Record<string, unknown> = {}, parts: Part[] = [part({ type: 'text', text: 'done' })]): SessionMessage => ({
  info: info({ id, sessionID: 'ses_1', role: 'assistant', time: { created, completed: created + 1500 }, agent: 'build', providerID: 'acme', modelID: 'acme-1', tokens: { input: 340, output: 1205 }, ...over }),
  parts,
});

const render = (messages: SessionMessage[], childSessions: { id: string; title?: string }[] = []): string => renderToStaticMarkup(
  <ActivityTimeline
    messages={messages}
    childSessions={childSessions}
    onOpenChild={() => {}}
    timeFormatPreference="24h"
    sessionKey="/p::ses_1"
  />,
);

describe('ActivityTimeline', () => {
  test('an empty session says there is no activity yet', () => {
    const html = render([]);
    expect(html).toContain('Activity');
    expect(html).toContain('No activity yet');
  });

  test('a turn shows its prompt and each step with who ran it, its cost and its time', () => {
    const html = render([user('u1', at, 'Fix the  login\nbug'), assistant('a1', at + 1000), assistant('a2', at + 3000, {}, [part({ type: 'reasoning' }), part({ type: 'tool', tool: 'shell' })])]);
    expect(html).toContain('Fix the login bug');
    expect(html).toContain('Step 1 of 2');
    expect(html).toContain('Step 2 of 2');
    expect(html).toContain('build · acme-1');
    expect(html).toContain('340 in · 1,205 out');
    expect(html).toContain('aria-label="340 tokens in, 1,205 tokens out"');
    expect(html).toContain('1.5s elapsed');
    expect(html).toContain('shell');
    expect(html).toContain(' · reasoning');
    expect(html.indexOf('Step 2 of 2')).toBeLessThan(html.indexOf('Step 1 of 2'));
    expect(html).toContain('Jan 15');
  });

  test('a step with no end yet reads as working', () => {
    const html = render([user('u1', at, 'Go'), assistant('a1', at + 1000, { time: { created: at + 1000 } })]);
    expect(html).toContain('Working');
    expect(html).not.toContain('elapsed');
  });

  test('a subagent sits under the step that started it, and one no step claims sits under the newest turn', () => {
    const call = part({ type: 'tool', tool: 'subagent', state: { status: 'completed', input: {}, metadata: { sessionID: 'ses_child' } } });
    const html = render(
      [user('u1', at, 'Research'), assistant('a1', at + 1000, {}, [call])],
      [{ id: 'ses_child', title: 'Look up the docs' }, { id: 'ses_lost' }],
    );
    expect(html).toContain('Look up the docs');
    expect(html).toContain('Untitled subagent');
    expect(html.indexOf('Untitled subagent')).toBeLessThan(html.indexOf('Look up the docs'));
    expect(html.indexOf('Step 1 of 1')).toBeLessThan(html.indexOf('Look up the docs'));
  });

  test('rows are collapsed until opened', () => {
    const html = render([user('u1', at, 'Go'), assistant('a1', at + 1000)]);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Copy JSON');
  });
});

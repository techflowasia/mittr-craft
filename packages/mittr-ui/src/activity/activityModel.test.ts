import { describe, expect, test } from 'bun:test';

import type { Message, Part } from '@/lib/opencode/model';
import {
  orphanChildren,
  readSpawnedSessionIds,
  readTokenCounts,
  stepLabel,
  stepTiming,
  timelineTurns,
  type SessionMessage,
} from './activityModel';

const info = (data: Record<string, unknown>): Message => data as unknown as Message;
const part = (data: Record<string, unknown>): Part => data as unknown as Part;

const user = (id: string, created: number, text = 'hello'): SessionMessage => ({
  info: info({ id, sessionID: 'ses_1', role: 'user', time: { created } }),
  parts: [part({ type: 'text', text })],
});

const assistant = (id: string, created: number, over: Record<string, unknown> = {}, parts: Part[] = []): SessionMessage => ({
  info: info({ id, sessionID: 'ses_1', role: 'assistant', time: { created, completed: created + 1500 }, agent: 'build', providerID: 'acme', modelID: 'acme-1', ...over }),
  parts,
});

const subagentCall = (sessionID: string): Part => part({ type: 'tool', tool: 'subagent', state: { status: 'completed', input: {}, metadata: { sessionID } } });

describe('readSpawnedSessionIds', () => {
  test('reads the child session from a subagent call result', () => {
    expect(readSpawnedSessionIds(assistant('a', 1, {}, [subagentCall('ses_child')]))).toEqual(['ses_child']);
  });

  test('accepts the legacy sessionId spelling', () => {
    const message = assistant('a', 1, {}, [
      part({ type: 'tool', tool: 'subagent', state: { status: 'running', input: {}, metadata: { sessionId: 'ses_legacy' } } }),
    ]);
    expect(readSpawnedSessionIds(message)).toEqual(['ses_legacy']);
  });

  test('falls back to the session a resumed call names in its input', () => {
    const message = assistant('a', 1, {}, [
      part({ type: 'tool', tool: 'subagent', state: { status: 'running', input: { sessionID: 'ses_resumed' } } }),
    ]);
    expect(readSpawnedSessionIds(message)).toEqual(['ses_resumed']);
  });

  test('ignores other tools and repeats', () => {
    const message = assistant('a', 1, {}, [
      part({ type: 'tool', tool: 'shell', state: { status: 'completed', input: {}, metadata: { sessionID: 'ses_no' } } }),
      subagentCall('ses_child'),
      subagentCall('ses_child'),
    ]);
    expect(readSpawnedSessionIds(message)).toEqual(['ses_child']);
  });
});

describe('readTokenCounts', () => {
  test('reads input and output from an assistant message', () => {
    expect(readTokenCounts(assistant('a', 1, { tokens: { input: 340, output: 1205 } }))).toEqual({ input: 340, output: 1205 });
  });

  test('zero is a real answer and a missing field is none', () => {
    expect(readTokenCounts(assistant('a', 1, { tokens: { input: 0, output: 0 } }))).toEqual({ input: 0, output: 0 });
    expect(readTokenCounts(assistant('a', 1))).toBeNull();
  });

  test('a user message carries no counters', () => {
    expect(readTokenCounts({ ...user('u', 1), info: info({ id: 'u', role: 'user', time: { created: 1 }, tokens: { input: 5, output: 5 } }) })).toBeNull();
  });
});

describe('stepTiming', () => {
  test('a finished assistant step has a duration', () => {
    expect(stepTiming(assistant('a', 1000))).toEqual({ running: false, duration: '1.5s' });
  });

  test('an assistant step with no end is running', () => {
    expect(stepTiming(assistant('a', 1000, { time: { created: 1000 } }))).toEqual({ running: true, duration: null });
  });

  test('a record that never ends is not running', () => {
    const notice: SessionMessage = { info: info({ id: 's', role: 'system', time: { created: 1000 }, text: 'x' }), parts: [] };
    expect(stepTiming(notice)).toEqual({ running: false, duration: null });
  });

  test('a shell record is running until it exits', () => {
    const shell = (status: string, completed?: number): SessionMessage => ({
      info: info({ id: 'sh', role: 'shell', time: { created: 1000, completed }, status, command: 'ls', shellID: 'x' }),
      parts: [],
    });
    expect(stepTiming(shell('running')).running).toBe(true);
    expect(stepTiming(shell('exited', 3000))).toEqual({ running: false, duration: '2.0s' });
  });
});

describe('stepLabel', () => {
  test('a step is named by its parts', () => {
    expect(stepLabel(assistant('a', 1, {}, [part({ type: 'reasoning' }), part({ type: 'tool', tool: 'shell' })]))).toEqual({ primary: 'shell', ambient: 'reasoning' });
  });

  test('a record with no parts is named by its role', () => {
    expect(stepLabel({ info: info({ id: 'c', role: 'compaction', time: { created: 1 } }), parts: [] })).toEqual({ primary: 'compaction', ambient: '' });
  });
});

describe('timelineTurns', () => {
  test('turns run newest first and steps keep their place in the turn', () => {
    const messages = [user('u1', 1000), assistant('a1', 1100), assistant('a2', 1200), user('u2', 2000), assistant('a3', 2100)];
    const turns = timelineTurns(messages);
    expect(turns.map(({ item }) => item.prompt?.info.id)).toEqual(['u2', 'u1']);
    expect(turns[1].item.steps.map((step) => `${step.message.info.id}:${step.index}/${step.total}`)).toEqual(['a1:1/2', 'a2:2/2']);
  });

  test('idle records are left out', () => {
    const idle: SessionMessage = { info: info({ id: 'i', role: 'idle', time: { created: 1300 }, outcome: 'completed' }), parts: [] };
    const turns = timelineTurns([user('u1', 1000), assistant('a1', 1100), idle]);
    expect(turns[0].item.steps.map((step) => step.message.info.id)).toEqual(['a1']);
  });

  test('each new day opens a heading on its newest turn', () => {
    const dayOne = new Date(2024, 0, 15, 9).getTime();
    const dayTwo = new Date(2024, 0, 16, 9).getTime();
    const turns = timelineTurns([user('u1', dayOne), user('u2', dayOne + 1000), user('u3', dayTwo)]);
    expect(turns.map(({ dayHeading }) => dayHeading)).toEqual([dayTwo, dayOne + 1000, null]);
  });
});

describe('orphanChildren', () => {
  test('a child no step claims is kept', () => {
    const messages = [user('u1', 1), assistant('a1', 2, {}, [subagentCall('ses_claimed')])];
    const children = [{ id: 'ses_claimed' }, { id: 'ses_lost', title: 'Lost' }];
    expect(orphanChildren(messages, children)).toEqual([{ id: 'ses_lost', title: 'Lost' }]);
  });
});

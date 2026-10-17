import { describe, expect, test } from 'bun:test';

import type { Message } from '../../../ui/src/lib/opencode/model';
import {
  ANSWERED_BY_ENDPOINT,
  ANSWERED_BY_RETRY_MS,
  answeredByFor,
  createAnsweredByController,
  parseAnsweredByList,
  substitutedAnswerOf,
  type AnsweredBy,
  type AnsweredByFetch,
  type AnsweredByList,
} from './answeredBy';

const ANSWER: AnsweredBy = { at: 1500, model: 'pm_1', reason: 'quota', requestedLabel: 'Writer', answeredLabel: 'Backup' };
const LIST: AnsweredByList = { now: 5000, answers: [ANSWER] };

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

const reply = (body: unknown, ok = true) => Promise.resolve({ ok, json: async () => body });

describe('reading the answered-by list', () => {
  test('keeps readable answers and drops the rest', () => {
    expect(parseAnsweredByList({ now: 2000, answers: [ANSWER, { ...ANSWER, reason: 'other' }, { at: 'x' }, null] }))
      .toEqual({ now: 2000, answers: [ANSWER] });
    expect(parseAnsweredByList({ answers: [] })).toBeNull();
    expect(parseAnsweredByList({ now: 1 })).toBeNull();
    expect(parseAnsweredByList(null)).toBeNull();
  });
});

describe('matching an answer to a message', () => {
  const message = { modelID: 'pm_1', created: 1000, completed: 2000 };

  test('matches by model and by the time the message ran', () => {
    expect(answeredByFor([ANSWER], message)).toEqual(ANSWER);
    expect(answeredByFor([ANSWER], { ...message, modelID: 'pm_2' })).toBeNull();
    expect(answeredByFor([ANSWER], { ...message, created: 1600 })).toBeNull();
    expect(answeredByFor([ANSWER], { ...message, completed: 1400 })).toBeNull();
    expect(answeredByFor([], message)).toBeNull();
  });

  test('the latest match wins', () => {
    const later = { ...ANSWER, at: 1800, reason: 'failed' as const };
    expect(answeredByFor([ANSWER, later], message)).toEqual(later);
  });

  test('only a completed Mittr answer can have one', () => {
    expect(substitutedAnswerOf(assistant(), LIST)).toEqual(ANSWER);
    expect(substitutedAnswerOf(assistant(), undefined)).toBeNull();
    expect(substitutedAnswerOf(assistant({ time: { created: 1000 } }), LIST)).toBeNull();
    expect(substitutedAnswerOf(assistant({ providerID: 'openai' }), LIST)).toBeNull();
    expect(substitutedAnswerOf(assistant({ role: 'user' }), LIST)).toBeNull();
    expect(substitutedAnswerOf(assistant({ id: 'msg_old', time: { created: 100, completed: 900 } }), LIST)).toBeNull();
  });
});

describe('answered-by controller', () => {
  const harness = (answers: Array<() => ReturnType<AnsweredByFetch>>) => {
    const paths: string[] = [];
    const queue = [...answers];
    const fetch: AnsweredByFetch = (path) => {
      paths.push(path);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return (next ?? (() => Promise.reject(new Error('offline'))))();
    };
    let at = 10_000;
    const controller = createAnsweredByController({ fetch, now: () => at });
    return { controller, paths, advance: (ms: number) => { at += ms; } };
  };

  test('asks once for messages that finish together, and not again for older ones', async () => {
    const { controller, paths } = harness([() => reply(LIST)]);
    expect(controller.snapshot('ses_1')).toBeUndefined();
    await Promise.all([controller.load('ses_1', 4500), controller.load('ses_1', 4800), controller.load('ses_1', 100)]);
    expect(paths).toEqual([`${ANSWERED_BY_ENDPOINT}?sessionId=ses_1`]);
    expect(controller.snapshot('ses_1')).toEqual(LIST);

    await controller.load('ses_1', 3000);
    expect(paths).toHaveLength(1);
    await controller.load('ses_1', 6000);
    expect(paths).toHaveLength(2);
    await controller.load('ses 2', 1000);
    expect(paths.at(-1)).toBe(`${ANSWERED_BY_ENDPOINT}?sessionId=ses%202`);
  });

  test('tells listeners when a list arrives', async () => {
    const { controller } = harness([() => reply(LIST)]);
    let heard = 0;
    const stop = controller.subscribe(() => { heard += 1; });
    await controller.load('ses_1', 4500);
    expect(heard).toBe(1);
    stop();
    await controller.load('ses_1', 9000);
    expect(heard).toBe(1);
  });

  test('a failed read keeps what was known and is not repeated at once', async () => {
    const { controller, paths, advance } = harness([() => reply(LIST), () => reply({}, false), () => Promise.reject(new Error('offline')), () => reply(LIST)]);
    await controller.load('ses_1', 4500);
    await controller.load('ses_1', 9000);
    expect(controller.snapshot('ses_1')).toEqual(LIST);
    expect(paths).toHaveLength(2);
    await controller.load('ses_1', 9100);
    expect(paths).toHaveLength(2);
    advance(ANSWERED_BY_RETRY_MS);
    await controller.load('ses_1', 9100);
    expect(paths).toHaveLength(3);
  });

  test('an unreadable body counts as a failed read', async () => {
    const { controller } = harness([() => reply({ nope: true })]);
    await controller.load('ses_1', 100);
    expect(controller.snapshot('ses_1')).toBeUndefined();
  });
});

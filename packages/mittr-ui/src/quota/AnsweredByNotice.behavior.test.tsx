import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as RealReact from 'react';

type Effect = { run: () => void; deps: unknown[] | undefined };

let slots: Array<Effect | undefined> = [];
let slotIndex = 0;
let pending: Array<() => void> = [];

const sameDeps = (left?: unknown[], right?: unknown[]) =>
  Boolean(left && right) && left?.length === right?.length && left?.every((value, index) => Object.is(value, right?.[index]));

const useEffect = (run: () => void, deps?: unknown[]) => {
  const index = slotIndex++;
  if (!sameDeps(slots[index]?.deps, deps)) {
    slots[index] = { run, deps };
    pending.push(run);
  }
};

const ReactMock = {
  ...RealReact,
  useEffect,
  useSyncExternalStore: <T,>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
};

mock.module('react', () => ({ __esModule: true, ...ReactMock, default: ReactMock }));

const { setAnsweredByController } = await import('./answeredBy');
const { AnsweredByNotice } = await import('./AnsweredByNotice');

import type { Message } from '../../../ui/src/lib/opencode/model';
import type { AnsweredByController, AnsweredByList } from './answeredBy';

type Element = { type: (props: Record<string, unknown>) => Element | null; props: Record<string, unknown> };

const LIST: AnsweredByList = {
  now: 5000,
  answers: [{ at: 1500, model: 'pm_1', reason: 'quota', requestedLabel: 'Writer', answeredLabel: 'Backup' }],
};

const message = (over: Record<string, unknown> = {}): Message => ({
  id: 'msg_a',
  sessionID: 'ses_1',
  role: 'assistant',
  time: { created: 1000, completed: 2000 },
  agent: 'build',
  providerID: 'mittr',
  modelID: 'pm_1',
  ...over,
}) as Message;

let loads: Array<[string, number]> = [];
let snapshots: string[] = [];

const controller: AnsweredByController = {
  snapshot: (sessionId) => {
    snapshots.push(sessionId);
    return LIST;
  },
  subscribe: () => () => undefined,
  load: (sessionId, completedAt) => {
    loads.push([sessionId, completedAt]);
    return Promise.resolve();
  },
};

const render = (info: Message) => {
  slotIndex = 0;
  const outer = AnsweredByNotice({ message: { info, parts: [] }, isLatestTurn: false }) as Element | null;
  const inner = outer ? outer.type(outer.props) : null;
  const effects = pending;
  pending = [];
  for (const run of effects) run();
  return { outer, inner };
};

describe('AnsweredByNotice reads the session once, and only for a completed Mittr answer', () => {
  beforeEach(() => {
    slots = [];
    pending = [];
    loads = [];
    snapshots = [];
    setAnsweredByController(controller);
  });

  test('an answer from another provider asks for nothing', () => {
    const { outer } = render(message({ providerID: 'openai' }));
    expect(outer).toBeNull();
    expect(loads).toEqual([]);
    expect(snapshots).toEqual([]);
  });

  test('a Mittr answer that has not completed asks for nothing', () => {
    const { outer } = render(message({ time: { created: 1000 } }));
    expect(outer).toBeNull();
    expect(loads).toEqual([]);
  });

  test('a user turn asks for nothing', () => {
    const { outer } = render({ id: 'msg_u', sessionID: 'ses_1', role: 'user', time: { created: 1 } } as Message);
    expect(outer).toBeNull();
    expect(loads).toEqual([]);
  });

  test('a completed Mittr answer asks for its session exactly once, however often it renders', () => {
    const first = render(message());
    expect(loads).toEqual([['ses_1', 2000]]);
    expect(first.inner?.props.list).toEqual(LIST);
    render(message());
    render(message());
    expect(loads).toEqual([['ses_1', 2000]]);
  });

  test('a later message of the same session asks again with its own completion time', () => {
    render(message());
    slots = [];
    render(message({ id: 'msg_b', time: { created: 3000, completed: 4000 } }));
    expect(loads).toEqual([['ses_1', 2000], ['ses_1', 4000]]);
  });
});

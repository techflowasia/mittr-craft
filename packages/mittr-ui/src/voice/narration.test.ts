import { afterEach, describe, expect, test } from 'bun:test';

import { translateWireEvent, type SyncEvent } from '../../../ui/src/lib/opencode/events';
import { applyDirectoryEvent } from '../../../ui/src/sync/event-reducer';
import { INITIAL_STATE, type State } from '../../../ui/src/sync/types';
import {
  createNarrationWatch,
  endingOf,
  noteUtterance,
  resetSpokenLanguage,
  spokenLanguage,
  spokenLanguageOf,
  spokenText,
  type SessionObservation,
} from './narration';

afterEach(() => resetSpokenLanguage());

const view = (patch: Partial<SessionObservation> = {}): SessionObservation => ({
  sessionId: 's1',
  busy: false,
  permissionIds: [],
  error: null,
  ended: null,
  ...patch,
});

describe('spoken language', () => {
  test('Thai script means Thai, anything else means English', () => {
    expect(spokenLanguageOf('งานเสร็จหรือยัง')).toBe('th');
    expect(spokenLanguageOf('open Chrome แล้วเข้า Slack')).toBe('th');
    expect(spokenLanguageOf('is the task done')).toBe('en');
    expect(spokenLanguageOf('')).toBe('en');
  });

  test('follows the last utterance and starts in English', () => {
    expect(spokenLanguage()).toBe('en');
    noteUtterance('เปิด Chrome ให้หน่อย');
    expect(spokenLanguage()).toBe('th');
    noteUtterance('thanks');
    expect(spokenLanguage()).toBe('en');
  });

  test('each narration is one sentence in the language of the last utterance', () => {
    expect(spokenText('done')).toBe('The work is done. Want a summary?');
    expect(spokenText('permission')).toBe('A permission request is waiting on screen.');
    expect(spokenText('error')).toBe('The work stopped with a problem; details are on screen.');
    expect(spokenText('stopped')).toBe('The work has stopped.');
    noteUtterance('งานเสร็จหรือยัง');
    for (const key of ['done', 'permission', 'error', 'stopped'] as const) {
      expect(/\p{Script=Thai}/u.test(spokenText(key))).toBe(true);
      expect(spokenText(key)).not.toBe(spokenText(key, 'en'));
    }
  });
});

describe('createNarrationWatch', () => {
  test('the first look at a session is a baseline and says nothing', () => {
    const watch = createNarrationWatch();
    expect(watch.observe(view({ busy: true, permissionIds: ['p1'], error: { at: 5, aborted: false } }))).toEqual([]);
  });

  test('busy to idle says the work is done, once', () => {
    const watch = createNarrationWatch();
    watch.observe(view({ busy: true }));
    expect(watch.observe(view({ busy: true }))).toEqual([]);
    expect(watch.observe(view({ busy: false }))).toEqual(['done']);
    expect(watch.observe(view({ busy: false }))).toEqual([]);
  });

  test('a new permission request is announced once; one already there is not', () => {
    const watch = createNarrationWatch();
    watch.observe(view({ busy: true, permissionIds: ['old'] }));
    expect(watch.observe(view({ busy: true, permissionIds: ['old', 'p2'] }))).toEqual(['permission']);
    expect(watch.observe(view({ busy: true, permissionIds: ['old', 'p2'] }))).toEqual([]);
    expect(watch.observe(view({ busy: true, permissionIds: [] }))).toEqual([]);
  });

  test('an error replaces the done that comes with it', () => {
    const watch = createNarrationWatch();
    watch.observe(view({ busy: true }));
    expect(watch.observe(view({ busy: false, error: { at: 100, aborted: false } }))).toEqual(['error']);
    expect(watch.observe(view({ busy: false, error: { at: 100, aborted: false } }))).toEqual([]);
  });

  test('an error seen before the watch started is not announced', () => {
    const watch = createNarrationWatch();
    watch.observe(view({ error: { at: 50, aborted: false } }));
    expect(watch.observe(view({ error: { at: 50, aborted: false } }))).toEqual([]);
    expect(watch.observe(view({ error: { at: 60, aborted: false } }))).toEqual(['error']);
  });

  test('stopping the work is narrated as stopped, never as a failure or done', () => {
    const watch = createNarrationWatch();
    watch.observe(view({ busy: true }));
    expect(watch.observe(view({ busy: false, error: { at: 100, aborted: true } }))).toEqual(['stopped']);
  });

  test('an error seen before the idle of the same run still suppresses done', () => {
    const watch = createNarrationWatch();
    watch.observe(view({ busy: true }));
    expect(watch.observe(view({ busy: true, error: { at: 100, aborted: false } }))).toEqual(['error']);
    expect(watch.observe(view({ busy: false, error: { at: 100, aborted: false } }))).toEqual([]);
  });

  test('a new run after an error says done again', () => {
    const watch = createNarrationWatch();
    watch.observe(view({ busy: true }));
    watch.observe(view({ busy: false, error: { at: 100, aborted: false } }));
    expect(watch.observe(view({ busy: true, error: { at: 100, aborted: false } }))).toEqual([]);
    expect(watch.observe(view({ busy: false, error: { at: 100, aborted: false } }))).toEqual(['done']);
  });

  test('switching sessions rebaselines without speaking', () => {
    const watch = createNarrationWatch();
    watch.observe(view({ busy: true }));
    expect(watch.observe(view({ sessionId: 's2', busy: false, permissionIds: ['p9'] }))).toEqual([]);
    expect(watch.observe(view({ sessionId: 's2', busy: true }))).toEqual([]);
    expect(watch.observe(view({ sessionId: 's2', busy: false }))).toEqual(['done']);
  });

  test('no open session says nothing', () => {
    const watch = createNarrationWatch();
    expect(watch.observe(view({ sessionId: null }))).toEqual([]);
    expect(watch.observe(view({ sessionId: null, busy: true }))).toEqual([]);
  });
});

describe('narration fed the 2.1.1 session events', () => {
  const durable = { aggregateID: 'ses_1', seq: 2, version: 1 as const };
  const wire = { id: 'evt_9', created: 2000, location: { directory: '/repo' } };
  const busyState = (): State => ({
    ...INITIAL_STATE,
    session: [{
      id: 'ses_1',
      projectID: 'proj_1',
      directory: '/repo',
      title: 'One',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      outcome: 'succeeded',
      time: { created: 1, updated: 1, idle: 500 },
    }],
    message: {},
    part: {},
    session_status: { ses_1: { type: 'busy' } },
    permission: {},
    form: {},
    sessionEventRevision: {},
    sessionDeletedRevision: {},
  });
  const observed = (state: State): SessionObservation => ({
    sessionId: 'ses_1',
    busy: state.session_status.ses_1?.type === 'busy',
    permissionIds: [],
    error: null,
    ended: endingOf(state.session.find((session) => session.id === 'ses_1')),
  });
  const narrated = (events: SyncEvent[]) => {
    const state = busyState();
    const watch = createNarrationWatch();
    watch.observe(observed(state));
    for (const event of events) applyDirectoryEvent(state, event);
    return watch.observe(observed(state));
  };

  test('a stop arrives as an interrupted idle and is narrated as stopped', () => {
    const events = translateWireEvent({ ...wire, type: 'session.execution.interrupted', durable, data: { sessionID: 'ses_1', reason: 'user' } });
    expect(events.find((event) => event.type === 'session.idle')).toEqual({ type: 'session.idle', properties: { sessionID: 'ses_1', outcome: 'interrupted' } });
    expect(narrated(events)).toEqual(['stopped']);
  });

  test('a finished turn is narrated as done', () => {
    expect(narrated(translateWireEvent({ ...wire, type: 'session.execution.succeeded', durable, data: { sessionID: 'ses_1' } }))).toEqual(['done']);
  });

  test('a failed turn is narrated once as an error, whichever of its outcome or its error is seen first', () => {
    const watch = createNarrationWatch();
    watch.observe(view({ busy: true, ended: { at: 500, outcome: 'succeeded' } }));
    expect(watch.observe(view({ busy: false, ended: { at: 2000, outcome: 'failed' } }))).toEqual(['error']);
    expect(watch.observe(view({ busy: false, ended: { at: 2000, outcome: 'failed' }, error: { at: 2001, aborted: false } }))).toEqual([]);
  });

  test('an outcome left from an earlier turn does not decide this one', () => {
    const watch = createNarrationWatch();
    watch.observe(view({ busy: false, ended: { at: 500, outcome: 'interrupted' } }));
    watch.observe(view({ busy: true, ended: { at: 500, outcome: 'interrupted' } }));
    expect(watch.observe(view({ busy: false, ended: { at: 500, outcome: 'interrupted' } }))).toEqual(['done']);
  });
});

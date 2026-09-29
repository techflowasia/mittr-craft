import { afterEach, describe, expect, test } from 'bun:test';
import {
  createNarrationWatch,
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
  errorAt: null,
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
    noteUtterance('งานเสร็จหรือยัง');
    for (const key of ['done', 'permission', 'error'] as const) {
      expect(/\p{Script=Thai}/u.test(spokenText(key))).toBe(true);
      expect(spokenText(key)).not.toBe(spokenText(key, 'en'));
    }
  });
});

describe('createNarrationWatch', () => {
  test('the first look at a session is a baseline and says nothing', () => {
    const watch = createNarrationWatch();
    expect(watch.observe(view({ busy: true, permissionIds: ['p1'], errorAt: 5 }))).toEqual([]);
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
    expect(watch.observe(view({ busy: false, errorAt: 100 }))).toEqual(['error']);
    expect(watch.observe(view({ busy: false, errorAt: 100 }))).toEqual([]);
  });

  test('an error seen before the watch started is not announced', () => {
    const watch = createNarrationWatch();
    watch.observe(view({ errorAt: 50 }));
    expect(watch.observe(view({ errorAt: 50 }))).toEqual([]);
    expect(watch.observe(view({ errorAt: 60 }))).toEqual(['error']);
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

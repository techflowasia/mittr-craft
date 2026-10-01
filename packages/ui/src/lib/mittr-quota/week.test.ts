import { describe, expect, test } from 'bun:test';

import { formatResetTime, isStillBlocked, nextWeeklyReset } from './week';

describe('nextWeeklyReset', () => {
  test('is the coming Monday 00:00 in Bangkok', () => {
    expect(nextWeeklyReset(Date.parse('2026-09-30T08:00:00.000Z'))).toBe('2026-10-04T17:00:00.000Z');
  });

  test('moves to the following week once Monday has started in Bangkok', () => {
    expect(nextWeeklyReset(Date.parse('2026-10-04T17:00:00.000Z'))).toBe('2026-10-11T17:00:00.000Z');
    expect(nextWeeklyReset(Date.parse('2026-10-04T16:59:59.000Z'))).toBe('2026-10-04T17:00:00.000Z');
  });
});

describe('isStillBlocked', () => {
  test('holds until the reset time and not after', () => {
    const resetsAt = '2026-10-04T17:00:00.000Z';
    expect(isStillBlocked(resetsAt, Date.parse('2026-10-04T16:59:00.000Z'))).toBe(true);
    expect(isStillBlocked(resetsAt, Date.parse('2026-10-04T17:00:00.000Z'))).toBe(false);
    expect(isStillBlocked(null, 0)).toBe(false);
  });
});

describe('formatResetTime', () => {
  test('names the day and the time', () => {
    const text = formatResetTime('2026-10-04T17:00:00.000Z', 'en-US');
    expect(/Oct/.test(text)).toBe(true);
    expect(/\d{1,2}:\d{2}/.test(text)).toBe(true);
  });
});

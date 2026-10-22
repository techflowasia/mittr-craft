import { describe, expect, test } from 'bun:test';

import { formatResetTime, PRODUCT_LOCALE, PRODUCT_TIME_ZONE } from '../quota/agentStatus';
import { isStillBlocked, nextWeeklyReset } from './week';

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

describe('the reset time people read', () => {
  test('names the day and the time in Bangkok', () => {
    const text = formatResetTime('2026-10-26T17:00:00Z', PRODUCT_LOCALE, PRODUCT_TIME_ZONE);
    expect(text.startsWith('Tue 27 Oct')).toBe(true);
    expect(text.endsWith('00:00')).toBe(true);
  });
});

import { describe, expect, test } from 'bun:test';
import type { Part } from '@opencode-ai/sdk/v2';

import {
  deriveMessageLabel,
  deriveUserSnippet,
  formatAssistantTokens,
  formatMessagePreviewClock,
  formatMessagePreviewDay,
  isSameCalendarDay,
  withDayHeadings,
  truncateMessageId,
} from '../rawMessagePreview';

const part = (data: Record<string, unknown>): Part => data as unknown as Part;

describe('truncateMessageId', () => {
  test('returns trailing 8 chars (suffix, not prefix)', () => {
    // OpenCode ids share a long common prefix (msg_e39e98d…); the suffix is
    // the only distinguishing region, so we surface the tail.
    const id = 'msg_e39e98d86001xA2wMRcvRuL5HT';
    expect(truncateMessageId(id)).toBe(id.slice(-8));
  });

  test('distinguishes two ids that differ only in suffix', () => {
    const a = 'msg_e39e98d86001xA2wMRcvRuL5HT';
    const b = 'msg_e39e98d0e001kmHn6dH5r3IHfs';
    expect(truncateMessageId(a)).not.toBe(truncateMessageId(b));
  });

  test('returns last 8 chars when longer', () => {
    expect(truncateMessageId('abcdefghij')).toBe('cdefghij');
  });

  test('returns id as-is when shorter than or equal to limit', () => {
    expect(truncateMessageId('abc')).toBe('abc');
    expect(truncateMessageId('12345678')).toBe('12345678');
  });

  test('handles empty string', () => {
    expect(truncateMessageId('')).toBe('');
  });

  test('respects custom length', () => {
    expect(truncateMessageId('abcdefghij', 4)).toBe('ghij');
  });
});

describe('deriveMessageLabel', () => {
  test('returns empty halves for no parts', () => {
    expect(deriveMessageLabel([])).toEqual({ primary: '', ambient: '' });
  });

  test('uses tool name for tool parts', () => {
    expect(deriveMessageLabel([part({ type: 'tool', tool: 'bash' })]).primary).toBe('bash');
  });

  test('demotes reasoning so the row leads with what the step did', () => {
    expect(
      deriveMessageLabel([
        part({ type: 'reasoning', text: 'thinking' }),
        part({ type: 'tool', tool: 'bash' }),
      ]),
    ).toEqual({ primary: 'bash', ambient: 'reasoning' });
  });

  test('keeps source order within the primary half', () => {
    expect(
      deriveMessageLabel([
        part({ type: 'reasoning' }),
        part({ type: 'text', text: 'hi' }),
        part({ type: 'tool', tool: 'bash' }),
      ]).primary,
    ).toBe('text + bash');
  });

  test('promotes ambient parts when nothing else is present', () => {
    expect(deriveMessageLabel([part({ type: 'reasoning' })])).toEqual({
      primary: 'reasoning',
      ambient: '',
    });
  });

  test('deduplicates labels', () => {
    expect(
      deriveMessageLabel([
        part({ type: 'text', text: 'a' }),
        part({ type: 'text', text: 'b' }),
        part({ type: 'tool', tool: 'bash' }),
      ]).primary,
    ).toBe('text + bash');
  });

  test('lowercases tool names', () => {
    expect(deriveMessageLabel([part({ type: 'tool', tool: 'Bash' })]).primary).toBe('bash');
  });

  test('falls back to "tool" for tool parts without a tool name', () => {
    expect(deriveMessageLabel([part({ type: 'tool' })]).primary).toBe('tool');
  });

  test('falls back to "unknown" for parts without a type', () => {
    expect(deriveMessageLabel([part({})]).primary).toBe('unknown');
  });
});

describe('formatMessagePreviewClock', () => {
  // Fixed timestamp: 2024-01-15 14:35:00 UTC. Local rendering will vary; we
  // only assert structural properties (no AM/PM in 24h mode, presence in 12h).
  const ts = Date.UTC(2024, 0, 15, 14, 35, 0);

  test('returns "-" for null', () => {
    expect(formatMessagePreviewClock(null, '24h')).toBe('-');
  });

  test('returns "-" for non-finite', () => {
    expect(formatMessagePreviewClock(Number.NaN, '24h')).toBe('-');
  });

  test('24h mode omits AM/PM markers', () => {
    expect(/AM|PM/i.test(formatMessagePreviewClock(ts, '24h'))).toBe(false);
  });

  test('12h mode includes AM or PM marker', () => {
    expect(/AM|PM/i.test(formatMessagePreviewClock(ts, '12h'))).toBe(true);
  });

  test('auto mode is non-empty', () => {
    expect(formatMessagePreviewClock(ts, 'auto').length > 0).toBe(true);
  });

  test('carries no date, which the day heading owns', () => {
    expect(formatMessagePreviewClock(ts, '24h')).not.toContain('2024');
  });
});

describe('formatMessagePreviewDay', () => {
  const ts = Date.UTC(2024, 0, 15, 14, 35, 0);

  test('returns "-" for null', () => {
    expect(formatMessagePreviewDay(null)).toBe('-');
  });

  test('omits the year within the current year', () => {
    const sameYear = Date.UTC(2024, 5, 2, 9, 0, 0);
    expect(formatMessagePreviewDay(sameYear, ts)).not.toContain('2024');
  });

  test('includes the year for another year', () => {
    expect(formatMessagePreviewDay(ts, Date.UTC(2026, 0, 1))).toContain('2024');
  });
});

describe('isSameCalendarDay', () => {
  test('true for two times on one local day', () => {
    const morning = new Date(2024, 0, 15, 1, 0, 0).getTime();
    const night = new Date(2024, 0, 15, 23, 59, 0).getTime();
    expect(isSameCalendarDay(morning, night)).toBe(true);
  });

  test('false across midnight', () => {
    const before = new Date(2024, 0, 15, 23, 59, 0).getTime();
    const after = new Date(2024, 0, 16, 0, 1, 0).getTime();
    expect(isSameCalendarDay(before, after)).toBe(false);
  });

  test('false when either side is missing', () => {
    expect(isSameCalendarDay(null, Date.now())).toBe(false);
    expect(isSameCalendarDay(Date.now(), null)).toBe(false);
  });
});

describe('deriveUserSnippet', () => {
  test('returns the first text part verbatim (no length cap)', () => {
    // CSS handles the visual truncation at column width; the helper just
    // returns the cleaned full string so consumers can decide what to do.
    expect(
      deriveUserSnippet([part({ type: 'text', text: 'hello world this is long' })]),
    ).toBe('hello world this is long');
  });

  test('preserves punctuation, accents, and unicode (React escapes at render)', () => {
    expect(
      deriveUserSnippet([part({ type: 'text', text: 'olá, mundo! 123' })]),
    ).toBe('olá, mundo! 123');
  });

  test('collapses whitespace runs and trims ends', () => {
    expect(
      deriveUserSnippet([part({ type: 'text', text: '  a\n\n  b\t\tc  ' })]),
    ).toBe('a b c');
  });

  test('uses attachment count fallback when no text part exists', () => {
    expect(deriveUserSnippet([part({ type: 'file' })])).toBe('1 attachment');
    expect(
      deriveUserSnippet([part({ type: 'file' }), part({ type: 'file' })]),
    ).toBe('2 attachments');
  });

  test('skips empty text parts and falls through to next text part', () => {
    expect(
      deriveUserSnippet([
        part({ type: 'text', text: '   ' }),
        part({ type: 'text', text: 'next' }),
      ]),
    ).toBe('next');
  });

  test('returns empty string when there are no parts at all', () => {
    expect(deriveUserSnippet([])).toBe('');
  });

  test('returns empty string when all parts are whitespace-only text (not attachments)', () => {
    expect(
      deriveUserSnippet([
        part({ type: 'text', text: '   ' }),
        part({ type: 'text', text: '' }),
      ]),
    ).toBe('');
  });
});

describe('formatAssistantTokens', () => {
  const fmt = (n: number) => n.toLocaleString('en-US');

  test('renders input and output separated by " / "', () => {
    expect(formatAssistantTokens(340, 1205, fmt)).toBe('340 / 1,205');
  });

  test('renders both zeros explicitly (does not hide 0/0)', () => {
    expect(formatAssistantTokens(0, 0, fmt)).toBe('0 / 0');
  });

  test('honors the caller-provided number formatter', () => {
    expect(formatAssistantTokens(1234, 5678, (n) => String(n))).toBe('1234 / 5678');
  });
});

describe('withDayHeadings', () => {
  const at = (year: number, month: number, day: number, hour: number) =>
    new Date(year, month, day, hour, 0, 0).getTime();

  test('opens a heading on the first item of each day', () => {
    const items = [at(2024, 0, 16, 9), at(2024, 0, 15, 23), at(2024, 0, 15, 8)];
    expect(withDayHeadings(items, (value) => value).map((row) => row.dayHeading)).toEqual([
      items[0],
      items[1],
      null,
    ]);
  });

  test('walks the given order rather than sorting', () => {
    const items = [at(2024, 0, 15, 8), at(2024, 0, 16, 9)];
    expect(withDayHeadings(items, (value) => value).map((row) => row.dayHeading)).toEqual(items);
  });

  test('a missing timestamp opens no heading and does not close the run', () => {
    const first = at(2024, 0, 15, 8);
    const later = at(2024, 0, 15, 20);
    const rows = withDayHeadings([first, null, later], (value) => value);
    expect(rows.map((row) => row.dayHeading)).toEqual([first, null, null]);
  });

  test('returns every item it was given', () => {
    const items = [at(2024, 0, 15, 8), null, at(2024, 0, 16, 9)];
    expect(withDayHeadings(items, (value) => value).map((row) => row.item)).toEqual(items);
  });
});

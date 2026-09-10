import type { Part } from '@opencode-ai/sdk/v2';
import type { TimeFormatPreference } from '@/stores/useUIStore';

/**
 * Helpers for the Raw Messages preview rows in the context sidebar.
 *
 * A row reads left to right as what the step did, what it cost, and when it
 * happened: the tool or reply that distinguishes it, then the ambient parts
 * that do not, then I/O token counters (assistant only), then a clock. Rows
 * run under a heading for each calendar day, which is why no row carries a
 * date of its own.
 *
 * The three columns are deliberately not one weight. Every value rendered at
 * the same muted weight is what the previous row degenerated into: a stack of
 * identical grey bars with nothing for the eye to hold.
 *
 * Note: `truncateMessageId` surfaces the **suffix** of a message id (last 8
 * chars), not the prefix. OpenCode ids share a long common prefix (e.g.
 * `msg_e39e98d…`); the tail is what actually differentiates them.
 *
 * Helpers here are pure and DOM-free so they can be unit tested.
 */

const PREVIEW_ID_LENGTH = 8;

const partRecord = (part: Part): Record<string, unknown> => part as unknown as Record<string, unknown>;

const partTypeOf = (part: Part): string => {
  const value = partRecord(part).type;
  return typeof value === 'string' ? value : '';
};

const partToolOf = (part: Part): string => {
  const value = partRecord(part).tool;
  return typeof value === 'string' ? value : '';
};

const partTextOf = (part: Part): string => {
  const value = partRecord(part).text;
  return typeof value === 'string' ? value : '';
};

const labelForPart = (part: Part): string => {
  const type = partTypeOf(part);
  if (type === 'tool') {
    const tool = partToolOf(part).trim().toLowerCase();
    return tool || 'tool';
  }
  return type || 'unknown';
};

/**
 * Part types that say how the assistant worked rather than what it did. They
 * appear on almost every assistant message, so a row that leads with them
 * reads as identical to the row above it and carries no information; the tool
 * or the reply is what distinguishes one step from the next.
 */
const AMBIENT_PART_TYPES = ['reasoning', 'step-start', 'step-finish'];

type MessageLabel = {
  /** What the step did. Never empty when the message has parts. */
  primary: string;
  /** How it worked. Rendered de-emphasised, and often empty. */
  ambient: string;
};

/**
 * Split a message's parts into what it did and how it worked.
 *
 * Source order is preserved inside each half, so a message that reasoned, then
 * replied, then ran a command reads `text + bash` rather than a re-sorted list
 * that no longer matches the transcript.
 *
 * When a message carries nothing but ambient parts they become the primary
 * label: a row with no label at all is worse than a row labelled `reasoning`.
 */
export const deriveMessageLabel = (parts: Part[]): MessageLabel => {
  const primary: string[] = [];
  const ambient: string[] = [];

  for (const part of parts) {
    const label = labelForPart(part);
    const bucket = AMBIENT_PART_TYPES.includes(partTypeOf(part)) ? ambient : primary;
    if (!bucket.includes(label)) {
      bucket.push(label);
    }
  }

  if (primary.length === 0) {
    return { primary: ambient.join(' + '), ambient: '' };
  }

  return { primary: primary.join(' + '), ambient: ambient.join(' + ') };
};

/**
 * Returns the trailing `length` characters of a message id. Used because all
 * ids share the same long prefix and only the suffix is distinguishable.
 */
export const truncateMessageId = (id: string, length: number = PREVIEW_ID_LENGTH): string => {
  if (typeof id !== 'string') return '';
  return id.length <= length ? id : id.slice(-length);
};

/**
 * Collapse whitespace runs into single spaces and trim ends. Keeps the
 * snippet on a single line in the preview row; CSS handles truncation
 * with an ellipsis at whatever width the column ends up rendering at.
 *
 * Punctuation, accents, and unicode are preserved — React escapes the
 * value at render time so there is no injection risk, and the row is
 * visually anchored by the bold `user:` prefix anyway.
 */
const collapseWhitespace = (text: string): string =>
  text.replace(/\s+/g, ' ').trim();

/**
 * Derive the inline snippet shown after `user:` on a user-row in the
 * Raw Messages preview. Returns the cleaned text of the first non-empty
 * text part, or `<N attachment[s]>` when the message carries no text
 * (e.g. file-only messages). Returns empty string when the message has
 * no parts at all.
 */
export const deriveUserSnippet = (parts: Part[]): string => {
  for (const part of parts) {
    if (partTypeOf(part) === 'text') {
      const cleaned = collapseWhitespace(partTextOf(part));
      if (cleaned.length === 0) continue;
      return cleaned;
    }
  }
  const nonTextCount = parts.filter((part) => partTypeOf(part) !== 'text').length;
  if (nonTextCount === 0) return '';
  return `${nonTextCount} attachment${nonTextCount === 1 ? '' : 's'}`;
};

/**
 * Format the assistant token counters as `<input> / <output>`. Both zero
 * still renders as `0 / 0` so streaming-not-started messages stay visible
 * in the column instead of disappearing. The row labels which half is which;
 * the bare slash was ambiguous on its own.
 */
export const formatAssistantTokens = (
  input: number,
  output: number,
  formatNumber: (value: number) => string,
): string => `${formatNumber(input)} / ${formatNumber(output)}`;

const resolveHour12 = (preference: TimeFormatPreference): boolean | undefined => {
  if (preference === '12h') return true;
  if (preference === '24h') return false;
  return undefined;
};

/**
 * Format the clock shown on a preview row, honouring the user's
 * `timeFormatPreference`. In 24h mode no AM/PM is rendered.
 *
 * The date is deliberately absent: rows are grouped under a day heading, so
 * repeating it on every row spent most of the column's width restating what
 * the heading already said.
 */
export const formatMessagePreviewClock = (
  timestamp: number | null,
  preference: TimeFormatPreference,
): string => {
  if (!timestamp || !Number.isFinite(timestamp)) return '-';
  const hour12 = resolveHour12(preference);
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: hour12 === false ? '2-digit' : 'numeric',
    minute: '2-digit',
    ...(hour12 === undefined ? {} : { hour12 }),
  });
};

/**
 * Format the day heading that a run of rows sits under. The year is included
 * only when it is not the current one, so an ordinary session does not carry a
 * year on every heading.
 */
export const formatMessagePreviewDay = (
  timestamp: number | null,
  now: number = Date.now(),
): string => {
  if (!timestamp || !Number.isFinite(timestamp)) return '-';
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
  });
};

/**
 * Whether two timestamps fall on the same local calendar day. Compared field
 * by field rather than by dividing into 24h buckets, which drifts across a
 * daylight-saving change and would then split or merge a day's rows.
 */
export const isSameCalendarDay = (a: number | null, b: number | null): boolean => {
  if (!a || !b || !Number.isFinite(a) || !Number.isFinite(b)) return false;
  const left = new Date(a);
  const right = new Date(b);
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
};

/**
 * Annotate an ordered run of items with the day heading each one opens.
 *
 * `dayHeading` carries the timestamp when the item is the first of its
 * calendar day in this ordering, and null otherwise, so the caller renders one
 * heading per day without tracking state across a `.map()`.
 *
 * Ordering is the caller's: the preview lists newest first, and this walks
 * whatever order it is handed rather than sorting, so it stays correct if that
 * choice changes. An item with no timestamp opens no heading and does not
 * close the run, because a missing time is not evidence the day changed.
 */
export const withDayHeadings = <T>(
  items: readonly T[],
  timestampOf: (item: T) => number | null,
): Array<{ item: T; dayHeading: number | null }> => {
  let currentDay: number | null = null;

  return items.map((item) => {
    const timestamp = timestampOf(item);
    if (timestamp === null || !Number.isFinite(timestamp)) {
      return { item, dayHeading: null };
    }
    if (isSameCalendarDay(currentDay, timestamp)) {
      return { item, dayHeading: null };
    }
    currentDay = timestamp;
    return { item, dayHeading: timestamp };
  });
};

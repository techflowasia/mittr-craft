import type { Part } from '@/lib/opencode/model';
import type { TimeFormatPreference } from '@/stores/useUIStore';

const partTypeOf = (part: Part): string => part.type ?? '';

const partToolOf = (part: Part): string => (part.type === 'tool' ? part.tool ?? '' : '');

const partTextOf = (part: Part): string => (part.type === 'text' ? part.text ?? '' : '');

const labelForPart = (part: Part): string => {
  const type = partTypeOf(part);
  if (type === 'tool') {
    const tool = partToolOf(part).trim().toLowerCase();
    return tool || 'tool';
  }
  return type || 'unknown';
};

const AMBIENT_PART_TYPES = ['reasoning', 'step-start', 'step-finish'];

export type MessageLabel = {
  primary: string;
  ambient: string;
};

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

const collapseWhitespace = (text: string): string => text.replace(/\s+/g, ' ').trim();

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

const resolveHour12 = (preference: TimeFormatPreference): boolean | undefined => {
  if (preference === '12h') return true;
  if (preference === '24h') return false;
  return undefined;
};

export const formatMessagePreviewClock = (
  timestamp: number | null,
  preference: TimeFormatPreference,
): string => {
  if (!timestamp || !Number.isFinite(timestamp)) return '-';
  const hour12 = resolveHour12(preference);
  const options: Intl.DateTimeFormatOptions = { hour: hour12 === false ? '2-digit' : 'numeric', minute: '2-digit' };
  if (hour12 !== undefined) options.hour12 = hour12;
  return new Date(timestamp).toLocaleTimeString(undefined, options);
};

export const formatMessagePreviewDay = (
  timestamp: number | null,
  now: number = Date.now(),
): string => {
  if (!timestamp || !Number.isFinite(timestamp)) return '-';
  const date = new Date(timestamp);
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== new Date(now).getFullYear()) options.year = 'numeric';
  return date.toLocaleDateString(undefined, options);
};

export const isSameCalendarDay = (a: number | null, b: number | null): boolean => {
  if (!a || !b || !Number.isFinite(a) || !Number.isFinite(b)) return false;
  const left = new Date(a);
  const right = new Date(b);
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
};

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

export const formatStepDuration = (
  created: number | null,
  completed: number | null,
): string | null => {
  if (created === null || completed === null) return null;
  if (!Number.isFinite(created) || !Number.isFinite(completed)) return null;
  const ms = completed - created;
  if (ms < 0) return null;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

export type ActivityStep<T> = {
  message: T;
  index: number;
  total: number;
};

export type ActivityTurn<T> = {
  prompt: T | null;
  steps: ActivityStep<T>[];
};

export const groupIntoTurns = <T>(
  messages: readonly T[],
  isPrompt: (message: T) => boolean,
): ActivityTurn<T>[] => {
  const turns: ActivityTurn<T>[] = [];
  let current: ActivityTurn<T> | null = null;

  for (const message of messages) {
    if (isPrompt(message) || current === null) {
      current = { prompt: isPrompt(message) ? message : null, steps: [] };
      turns.push(current);
      if (isPrompt(message)) continue;
    }
    current.steps.push({ message, index: current.steps.length + 1, total: 0 });
  }

  for (const turn of turns) {
    for (const step of turn.steps) step.total = turn.steps.length;
  }

  return turns;
};

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function nextWeeklyReset(now: number): string {
  const local = new Date(now + BANGKOK_OFFSET_MS);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const daysUntilMonday = ((8 - local.getUTCDay()) % 7) || 7;
  return new Date(midnight + daysUntilMonday * DAY_MS - BANGKOK_OFFSET_MS).toISOString();
}

export function isStillBlocked(resetsAt: string | null, now: number): boolean {
  return resetsAt !== null && Date.parse(resetsAt) > now;
}

export function formatResetTime(resetsAt: string, intlLocale: string): string {
  return new Intl.DateTimeFormat(intlLocale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(resetsAt));
}

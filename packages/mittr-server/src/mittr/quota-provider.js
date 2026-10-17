import { MITTR_PROVIDER_ID } from './policies.js';

const WEEKLY = 'weekly';
const NO_MODEL = 'No model available this week';
const READ_FAILED = 'Could not read this week’s quota';
const OTHER_MODEL = 'Other system model';

const KIND_NAMES = { chat: 'Chat', image: 'Images', stt: 'Voice input', tts: 'Spoken replies' };

const ROLE_NAMES = {
  'quota.role.decision': 'System decision model (Jev)',
  'quota.role.decisionRoute': 'Decision steps (measured route)',
  'quota.role.tools': 'Tool steps (measured route)',
  'quota.role.prose': 'Writing steps (measured route)',
  'quota.role.rerank': 'Search result ranking',
  'quota.role.image': 'Image drawing',
  'quota.role.visionCheck': 'Checking text on images',
  'quota.role.manager': 'Team manager (assigns, summarises, reviews)',
  'quota.role.default': 'System default model',
  'quota.model.other': OTHER_MODEL,
  'quota.fallback.label': 'Fallback for system models without their own limit',
};

const FAILURES = {
  not_signed_in: 'Sign in to Mittr to see this week’s quota',
  unreachable: 'Cannot reach Mittr',
  upstream_timeout: 'Cannot reach Mittr',
  not_available: 'Mittr does not report a quota for this account',
};

const formatCount = (value, maximumFractionDigits = 0) => (
  new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(Math.max(0, value))
);

const minutesOf = (seconds) => Math.max(0, seconds) / 60;
const minuteDigits = (minutes) => (minutes < 10 ? 1 : 0);

const leftLabel = ({ kind, used, limit }) => {
  const left = Math.max(0, limit - used);
  if (kind === 'stt') {
    const limitMinutes = minutesOf(limit);
    const leftMinutes = minutesOf(left);
    return `${formatCount(leftMinutes, minuteDigits(leftMinutes))} of ${formatCount(limitMinutes, minuteDigits(limitMinutes))} min left`;
  }
  return `${formatCount(Math.round(left))} of ${formatCount(Math.round(limit))} left`;
};

const usedPercentOf = ({ used, limit }) => Math.min(100, Math.max(0, (used / limit) * 100));

const lineName = (line) => line.label || ROLE_NAMES[line.labelKey] || OTHER_MODEL;

const uniqueName = (taken, line) => {
  const name = lineName(line);
  if (!taken.has(name)) return name;
  const withKind = `${name} · ${KIND_NAMES[line.kind]}`;
  if (!taken.has(withKind)) return withKind;
  for (let n = 2; ; n += 1) {
    const numbered = `${withKind} ${n}`;
    if (!taken.has(numbered)) return numbered;
  }
};

const windowSecondsOf = ({ weekStart, resetsAt }) => {
  const seconds = (Date.parse(resetsAt) - Date.parse(weekStart)) / 1000;
  return seconds > 0 ? seconds : null;
};

export const mittrQuotaProvider = ({ service, isSignedIn, isBrokerConfigured, buildResult, toUsageWindow }) => {
  const result = (fields) => buildResult({ providerId: MITTR_PROVIDER_ID, providerName: 'Mittr', ...fields });

  const isConfigured = () => {
    try {
      return Boolean(isBrokerConfigured() && isSignedIn());
    } catch {
      return false;
    }
  };

  const fetchQuota = async () => {
    let week;
    try {
      week = await service.readMine();
    } catch (error) {
      return result({ ok: false, configured: true, error: FAILURES[error?.reasonCode] ?? READ_FAILED });
    }

    const resetAt = Date.parse(week.resetsAt);
    const windowSeconds = windowSecondsOf(week);
    if (week.lines.length === 0) {
      return result({ ok: true, configured: true, usage: { windows: {}, models: {} }, planLabel: NO_MODEL });
    }

    const models = {};
    const taken = new Set();
    for (const line of week.lines) {
      const name = uniqueName(taken, line);
      taken.add(name);
      models[name] = {
        windows: {
          [WEEKLY]: toUsageWindow({ usedPercent: usedPercentOf(line), windowSeconds, resetAt, valueLabel: leftLabel(line) }),
        },
      };
    }
    const overall = Math.max(...week.lines.map(usedPercentOf));
    return result({
      ok: true,
      configured: true,
      usage: { windows: { [WEEKLY]: toUsageWindow({ usedPercent: overall, windowSeconds, resetAt }) }, models },
    });
  };

  return { providerId: MITTR_PROVIDER_ID, providerName: 'Mittr', isConfigured, fetchQuota };
};

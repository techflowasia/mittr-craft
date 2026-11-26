import { CANNOT_REACH_MITTR, READ_FAILED } from './platform.js';
import { MITTR_PROVIDER_ID } from './policies.js';

const WEEKLY = 'weekly';
const NO_MODEL = 'No model available this week';

const KIND_NAMES = { chat: 'Chat', image: 'Images', stt: 'Voice input', tts: 'Spoken replies' };
const SPEECH = new Set(['stt', 'tts']);

const FAILURES = {
  not_signed_in: 'Sign in to Mittr to see this week’s quota',
  unreachable: CANNOT_REACH_MITTR,
  upstream_timeout: CANNOT_REACH_MITTR,
  not_available: 'Mittr does not report a quota for this account',
  not_permitted: 'This week’s quota is not available to you',
};

const formatCount = (value, maximumFractionDigits = 0) => (
  new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(Math.max(0, value))
);

const formatSpeechSeconds = (seconds) => {
  const minutes = Math.max(0, seconds) / 60;
  if (minutes < 60) return `${formatCount(minutes, minutes < 10 ? 1 : 0)} min`;
  const total = Math.round(minutes);
  const hours = formatCount(Math.floor(total / 60));
  const rest = total % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
};

const leftLabel = ({ kind, used, limit }) => {
  const left = Math.max(0, limit - used);
  if (kind === 'stt') return `${formatSpeechSeconds(left)} of ${formatSpeechSeconds(limit)} left`;
  return `${formatCount(Math.round(left))} of ${formatCount(Math.round(limit))} left`;
};

const usedPercentOf = ({ used, limit }) => Math.min(100, Math.max(0, (used / limit) * 100));

const lineName = (line) => line.label || KIND_NAMES[line.kind];

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

const ownLines = (week, models) => {
  const names = new Map();
  const chat = week.lines.filter((line) => line.kind === 'chat');
  for (const { alias, label } of models.items) {
    const explicit = week.agentStatus && Object.hasOwn(week.agentStatus, alias) ? week.agentStatus[alias] : undefined;
    const matches = explicit
      ? chat.filter((line) => line.modelKey === explicit.modelKey)
      : chat.filter((line) => line.agents?.some((agent) => agent.key === alias));
    const candidates = matches.length || explicit ? matches : chat.filter((line) => line.modelKey === alias);
    const keys = new Set(candidates.map((line) => line.modelKey));
    if (keys.size !== 1) continue;
    const key = candidates[0].modelKey;
    if (!names.has(key)) names.set(key, new Set());
    names.get(key).add(label || alias);
  }
  const seen = new Set();
  return week.lines.flatMap((line) => {
    if (SPEECH.has(line.kind)) return [line];
    if (line.kind !== 'chat' || !names.has(line.modelKey) || seen.has(line.modelKey)) return [];
    seen.add(line.modelKey);
    return [{ ...line, label: [...names.get(line.modelKey)].join(', ') }];
  });
};

const windowSecondsOf = ({ weekStart, resetsAt }) => {
  const seconds = (Date.parse(resetsAt) - Date.parse(weekStart)) / 1000;
  return seconds > 0 ? seconds : null;
};

export const mittrQuotaProvider = ({ service, isSignedIn, isBrokerConfigured, catalogModels, accountGeneration = () => 0, buildResult, toUsageWindow }) => {
  const result = (fields) => buildResult({ providerId: MITTR_PROVIDER_ID, providerName: 'Mittr', ...fields });

  const isConfigured = () => {
    try {
      return Boolean(isBrokerConfigured() && isSignedIn());
    } catch {
      return false;
    }
  };

  const fetchQuota = async () => {
    const generation = accountGeneration();
    const held = catalogModels();
    let week;
    try {
      week = await service.readMine();
    } catch (error) {
      return result({ ok: false, configured: true, error: FAILURES[error?.reasonCode] ?? READ_FAILED });
    }

    const resetAt = Date.parse(week.resetsAt);
    const windowSeconds = windowSecondsOf(week);
    if (generation !== accountGeneration() || held?.configured !== true) return result({ ok: false, configured: true, error: READ_FAILED });
    const lines = ownLines(week, held);
    if (lines.length === 0) {
      return result({ ok: true, configured: true, usage: { windows: { [NO_MODEL]: toUsageWindow({ usedPercent: null, resetAt: null }) }, models: {} } });
    }

    const taken = new Set();
    const models = Object.fromEntries(lines.map((line) => {
      const name = uniqueName(taken, line);
      taken.add(name);
      return [name, {
        windows: {
          [WEEKLY]: toUsageWindow({ usedPercent: usedPercentOf(line), windowSeconds, resetAt, valueLabel: leftLabel(line) }),
        },
      }];
    }));
    const overall = Math.max(...lines.map(usedPercentOf));
    return result({
      ok: true,
      configured: true,
      usage: { windows: { [WEEKLY]: toUsageWindow({ usedPercent: overall, windowSeconds, resetAt }) }, models },
    });
  };

  return { providerId: MITTR_PROVIDER_ID, providerName: 'Mittr', isConfigured, fetchScope: accountGeneration, fetchQuota };
};

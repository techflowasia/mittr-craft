import type { I18nKey, I18nParams } from '@/lib/i18n';

import type { QuotaKind } from './exhausted';
import type { QuotaAgentStatus, QuotaUsageLine } from './quota-me';

type Translate = (key: I18nKey, params?: I18nParams) => string;

const QUOTA_KIND_ORDER: readonly QuotaKind[] = ['chat', 'image', 'stt', 'tts'];

export const QUOTA_KIND_KEY: Record<QuotaKind, I18nKey> = {
  chat: 'quota.kind.chat',
  image: 'quota.kind.image',
  stt: 'quota.kind.stt',
  tts: 'quota.kind.tts',
};

const UNIT_KEY: Record<Exclude<QuotaKind, 'stt'>, I18nKey> = {
  chat: 'quota.unit.chat',
  image: 'quota.unit.image',
  tts: 'quota.unit.tts',
};

export const QUOTA_AGENT_NAMES_SHOWN = 4;

export function quotaModelName(line: Pick<QuotaUsageLine, 'label' | 'labelKey'>, t: Translate): string {
  if (line.labelKey) return t(line.labelKey);
  return line.label || t('quota.model.other');
}

export function quotaShare(line: Pick<QuotaUsageLine, 'used' | 'limit'>): number {
  if (line.limit <= 0) return 1;
  return Math.min(1, Math.max(0, line.used / line.limit));
}

const formatCount = (value: number, intlLocale: string, fractionDigits = 0) =>
  new Intl.NumberFormat(intlLocale, { maximumFractionDigits: fractionDigits }).format(Math.max(0, value));

function formatSpeechSeconds(seconds: number, intlLocale: string, t: Translate): string {
  const minutes = Math.max(0, seconds) / 60;
  if (minutes < 60) return t('quota.unit.stt', { n: formatCount(minutes, intlLocale, minutes < 10 ? 1 : 0) });
  const total = Math.round(minutes);
  const hours = formatCount(Math.floor(total / 60), intlLocale);
  const rest = total % 60;
  return rest === 0
    ? t('quota.unit.sttHours', { h: hours })
    : t('quota.unit.sttHoursMinutes', { h: hours, m: rest });
}

export function formatQuotaAmount(kind: QuotaKind, amount: number, intlLocale: string, t: Translate): string {
  if (kind === 'stt') return formatSpeechSeconds(amount, intlLocale, t);
  return t(UNIT_KEY[kind], { n: formatCount(Math.round(amount), intlLocale) });
}

export function quotaLeftText(line: Pick<QuotaUsageLine, 'kind' | 'used' | 'limit'>, intlLocale: string, t: Translate): string {
  const left = Math.max(0, line.limit - line.used);
  return t('quota.me.left', {
    left: line.kind === 'stt' ? formatSpeechSeconds(left, intlLocale, t) : formatCount(Math.round(left), intlLocale),
    limit: formatQuotaAmount(line.kind, line.limit, intlLocale, t),
  });
}

export function quotaUsedText(line: Pick<QuotaUsageLine, 'kind' | 'used'>, intlLocale: string, t: Translate): string {
  return t('quota.me.used', { used: formatQuotaAmount(line.kind, line.used, intlLocale, t) });
}

export function quotaAgentsText(labels: readonly string[], t: Translate, shown = QUOTA_AGENT_NAMES_SHOWN): string {
  const visible = labels.slice(0, shown).join(', ');
  const hidden = labels.length - shown;
  return t('quota.me.agents', {
    names: hidden > 0 ? `${visible} ${t('quota.me.agentsMore', { n: hidden })}` : visible,
  });
}

export interface QuotaKindGroup {
  kind: QuotaKind;
  lines: QuotaUsageLine[];
}

export function groupQuotaLines(lines: readonly QuotaUsageLine[]): QuotaKindGroup[] {
  return QUOTA_KIND_ORDER.flatMap((kind) => {
    const ofKind = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.kind === kind)
      .sort((a, b) => quotaShare(b.line) - quotaShare(a.line) || a.index - b.index)
      .map(({ line }) => line);
    return ofKind.length ? [{ kind, lines: ofKind }] : [];
  });
}

export type AgentQuotaBadge =
  | { kind: 'out'; resetsAt: string }
  | { kind: 'substitute'; label: string | null }
  | { kind: 'near'; leftPercent: number };

export function agentQuotaBadge(status: QuotaAgentStatus | undefined): AgentQuotaBadge | null {
  if (!status) return null;
  switch (status.state) {
    case 'out':
      return { kind: 'out', resetsAt: status.resetsAt };
    case 'substitute':
      return { kind: 'substitute', label: status.substituteLabel ?? null };
    case 'near':
      return {
        kind: 'near',
        leftPercent: status.percentLeft ?? Math.max(1, Math.floor((status.left / Math.max(1, status.limit)) * 100)),
      };
    default:
      return null;
  }
}

const QUOTA_WARN_SHARE = 0.8;

export function quotaTonePercent(share: number): number {
  if (share >= 1) return 100;
  return share >= QUOTA_WARN_SHARE ? 50 : 0;
}

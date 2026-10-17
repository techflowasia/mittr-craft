import type { ModelEntryStatus } from '../../../ui/src/lib/product-plugins';
import { mittrT } from '../strings/mittrT';
import type { AgentStatus } from './quotaMeStore';

const MITTR_PROVIDER_ID = 'mittr';
const PRODUCT_LOCALE = 'en-GB';
const PRODUCT_TIME_ZONE = 'Asia/Bangkok';

const resetFormats = new Map<string, Intl.DateTimeFormat>();

const formatResetTime = (resetsAt: string, locale: string, timeZone: string): string => {
  const key = `${locale}|${timeZone}`;
  let format = resetFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    });
    resetFormats.set(key, format);
  }
  return format.format(new Date(resetsAt));
};

const percentLeftOf = (status: AgentStatus): number => (
  status.percentLeft ?? Math.max(1, Math.floor((status.left / Math.max(1, status.limit)) * 100))
);

export function agentEntryStatus(
  status: AgentStatus | undefined,
  agentName: string,
  t: typeof mittrT = mittrT,
  locale: string = PRODUCT_LOCALE,
  timeZone: string = PRODUCT_TIME_ZONE,
): ModelEntryStatus | null {
  if (!status) return null;
  switch (status.state) {
    case 'out':
      return {
        blocked: true,
        tone: 'neutral',
        pill: t('mittr.quota.agent.out'),
        title: t('mittr.quota.agent.outLabel', { agent: agentName, when: formatResetTime(status.resetsAt, locale, timeZone) }),
      };
    case 'substitute':
      return {
        blocked: false,
        tone: 'neutral',
        pill: t('mittr.quota.agent.backup'),
        title: status.substituteLabel
          ? t('mittr.quota.agent.backupLabel', { agent: agentName, model: status.substituteLabel })
          : t('mittr.quota.agent.backupLabelUnnamed', { agent: agentName }),
      };
    case 'near': {
      const n = percentLeftOf(status);
      return {
        blocked: false,
        tone: 'near',
        pill: t('mittr.quota.agent.left', { n }),
        title: t('mittr.quota.agent.leftLabel', { agent: agentName, n }),
      };
    }
    case 'ok':
      return null;
  }
}

export function mittrEntryStatus(
  agentStatus: ReadonlyMap<string, AgentStatus> | null,
): (entry: { providerID: string; modelID: string; name: string }) => ModelEntryStatus | null {
  return (entry) => (
    entry.providerID === MITTR_PROVIDER_ID && agentStatus
      ? agentEntryStatus(agentStatus.get(entry.modelID), entry.name)
      : null
  );
}

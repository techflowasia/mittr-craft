import React from 'react';

import type { ModelPickerEntry, ModelPickerEntryStatus } from '@/components/model-picker/ModelPickerList';
import { isVSCodeRuntime } from '@/lib/desktop';
import { getCurrentIntlLocale, useI18n, type I18nKey, type I18nParams } from '@/lib/i18n';
import { agentQuotaBadge } from '@/lib/mittr-quota/format';
import type { QuotaAgentStatus } from '@/lib/mittr-quota/quota-me';
import { MITTR_PROVIDER_ID, useQuotaMeStore } from '@/lib/mittr-quota/quota-me-store';
import { formatResetTime } from '@/lib/mittr-quota/week';

type Translate = (key: I18nKey, params?: I18nParams) => string;

export function mittrAgentEntryStatus(
  status: QuotaAgentStatus | undefined,
  agent: string,
  t: Translate,
  intlLocale: string,
): ModelPickerEntryStatus | null {
  const badge = agentQuotaBadge(status);
  if (!badge) return null;
  if (badge.kind === 'out') {
    return {
      blocked: true,
      tone: 'neutral',
      pill: t('quota.agent.out'),
      title: t('quota.agent.outLabel', { agent, when: formatResetTime(badge.resetsAt, intlLocale) }),
    };
  }
  if (badge.kind === 'substitute') {
    return {
      blocked: false,
      tone: 'neutral',
      pill: t('quota.agent.backup'),
      title: badge.label
        ? t('quota.agent.backupLabel', { agent, model: badge.label })
        : t('quota.agent.backupLabelUnnamed', { agent }),
    };
  }
  return {
    blocked: false,
    tone: 'near',
    pill: t('quota.agent.left', { n: badge.leftPercent }),
    title: t('quota.agent.leftLabel', { agent, n: badge.leftPercent }),
  };
}

export function useMittrAgentEntryStatus(open: boolean): (entry: ModelPickerEntry) => ModelPickerEntryStatus | null {
  const { t } = useI18n();
  const state = useQuotaMeStore((store) => store.state);
  const load = useQuotaMeStore((store) => store.load);
  const statuses = state.status === 'ok' ? state.quota.agentStatus : undefined;

  React.useEffect(() => {
    if (open && !isVSCodeRuntime()) void load();
  }, [open, load]);

  return React.useCallback((entry: ModelPickerEntry) => {
    if (entry.providerID !== MITTR_PROVIDER_ID || !statuses) return null;
    const agent = typeof entry.model.name === 'string' && entry.model.name ? entry.model.name : entry.modelID;
    return mittrAgentEntryStatus(statuses[entry.modelID], agent, t, getCurrentIntlLocale());
  }, [statuses, t]);
}

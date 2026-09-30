import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_FIELD_LABEL_CLASS,
  SETTINGS_HELPER_CLASS,
  SettingsControlGroup,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { getCurrentIntlLocale, useI18n, type I18nKey } from '@/lib/i18n';
import {
  QUOTA_AGENT_NAMES_SHOWN,
  QUOTA_KIND_KEY,
  groupQuotaLines,
  quotaAgentsText,
  quotaLeftText,
  quotaModelName,
  quotaShare,
  quotaTonePercent,
  quotaUsedText,
} from '@/lib/mittr-quota/format';
import type { QuotaUsageLine } from '@/lib/mittr-quota/quota-me';
import { MITTR_PROVIDER_ID, useQuotaMeStore, type QuotaMeState } from '@/lib/mittr-quota/quota-me-store';
import { formatResetTime } from '@/lib/mittr-quota/week';
import { cn } from '@/lib/utils';

import { UsageProgressBar } from './UsageProgressBar';

const STATUS_KEY: Record<'loading' | 'not_signed_in' | 'unreachable' | 'failed', I18nKey> = {
  loading: 'quota.me.loading',
  not_signed_in: 'quota.me.notSignedIn',
  unreachable: 'quota.me.unreachable',
  failed: 'quota.me.failed',
};

const QuotaAgentsLine: React.FC<{ labels: string[] }> = ({ labels }) => {
  const { t } = useI18n();
  const text = quotaAgentsText(labels, t);
  if (labels.length <= QUOTA_AGENT_NAMES_SHOWN) {
    return <p className={cn(SETTINGS_HELPER_CLASS, '[overflow-wrap:anywhere]')}>{text}</p>;
  }
  const full = t('quota.me.agents', { names: labels.join(', ') });
  return (
    <p className={cn(SETTINGS_HELPER_CLASS, '[overflow-wrap:anywhere]')} title={full}>
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{full}</span>
    </p>
  );
};

const QuotaLineRow: React.FC<{ line: QuotaUsageLine; resetsAt: string; intlLocale: string }> = ({ line, resetsAt, intlLocale }) => {
  const { t } = useI18n();
  const share = quotaShare(line);
  const name = quotaModelName(line, t);
  const left = quotaLeftText(line, intlLocale, t);
  return (
    <li className="space-y-1.5" data-quota-line={`${line.kind}:${line.modelKey}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className={cn(SETTINGS_FIELD_LABEL_CLASS, 'min-w-0 [overflow-wrap:anywhere]')}>{name}</span>
        <span className="typography-meta shrink-0 font-medium tabular-nums text-foreground">{left}</span>
      </div>
      <UsageProgressBar percent={share * 100} tonePercent={quotaTonePercent(share)} label={`${name} ${left}`} />
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 typography-meta tabular-nums text-muted-foreground">
        <span>{quotaUsedText(line, intlLocale, t)}</span>
        {share >= 1 ? (
          <span className="text-[var(--status-error)]">
            {t('quota.me.resets', { when: formatResetTime(resetsAt, intlLocale) })}
          </span>
        ) : null}
      </div>
      {line.agents?.length ? <QuotaAgentsLine labels={line.agents.map((agent) => agent.label)} /> : null}
    </li>
  );
};

export const MittrQuotaView: React.FC<{ state: QuotaMeState; onReload: () => void }> = ({ state, onReload }) => {
  const { t } = useI18n();
  const intlLocale = getCurrentIntlLocale();

  return (
    <SettingsPageLayout
      title={t('settings.usage.page.header.providerUsage', { provider: 'Mittr' })}
      titleLeading={<ProviderLogo providerId={MITTR_PROVIDER_ID} className="h-5 w-5 shrink-0" />}
      description={state.status === 'ok' ? t('quota.me.resets', { when: formatResetTime(state.quota.resetsAt, intlLocale) }) : undefined}
    >
      <SettingsSection
        divider={false}
        title={t('quota.me.title')}
        info={t('quota.me.info')}
        settingsItem="sessions.mittrQuota"
        headerAction={
          state.status === 'loading' ? null : (
            <Button type="button" variant="ghost" size="xs" onClick={onReload}>
              <Icon name="refresh" aria-hidden="true" />
              {t('quota.me.reload')}
            </Button>
          )
        }
      >
        {state.status === 'ok' ? (
          state.quota.lines.length === 0 ? (
            <p className={SETTINGS_HELPER_CLASS}>{t('quota.me.empty')}</p>
          ) : (
            <div className="w-full max-w-[32rem] space-y-6">
              {groupQuotaLines(state.quota.lines).map((group) => (
                <SettingsControlGroup key={group.kind} title={t(QUOTA_KIND_KEY[group.kind])}>
                  <ul className="space-y-4">
                    {group.lines.map((line) => (
                      <QuotaLineRow
                        key={`${line.kind}:${line.modelKey}`}
                        line={line}
                        resetsAt={state.quota.resetsAt}
                        intlLocale={intlLocale}
                      />
                    ))}
                  </ul>
                </SettingsControlGroup>
              ))}
            </div>
          )
        ) : state.status === 'not_available' ? null : (
          <p
            role={state.status === 'loading' ? 'status' : 'alert'}
            className={cn(SETTINGS_HELPER_CLASS, state.status !== 'loading' && 'text-[var(--status-warning)]')}
          >
            {t(STATUS_KEY[state.status])}
          </p>
        )}
      </SettingsSection>
    </SettingsPageLayout>
  );
};

export const MittrUsagePage: React.FC = () => {
  const state = useQuotaMeStore((store) => store.state);
  const load = useQuotaMeStore((store) => store.load);

  React.useEffect(() => {
    void load();
  }, [load]);

  const reload = React.useCallback(() => {
    void load({ force: true });
  }, [load]);

  return <MittrQuotaView state={state} onReload={reload} />;
};

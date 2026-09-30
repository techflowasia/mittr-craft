import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SETTINGS_FIELD_LABEL_CLASS, SETTINGS_HELPER_CLASS, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { UsageProgressBar } from '@/components/sections/usage/UsageProgressBar';
import { Button } from '@/components/ui/button';
import { getCurrentIntlLocale, useI18n, type I18nKey } from '@/lib/i18n';
import type { QuotaKind } from '@/lib/mittr-quota/exhausted';
import { fetchQuotaMe, usedPercent, type QuotaMeResult } from '@/lib/mittr-quota/quota-me';
import { formatResetTime } from '@/lib/mittr-quota/week';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { cn } from '@/lib/utils';

export type QuotaMeState = { status: 'loading' } | QuotaMeResult;

const KIND_KEY: Record<QuotaKind, I18nKey> = {
  chat: 'quota.kind.chat',
  image: 'quota.kind.image',
  stt: 'quota.kind.stt',
  tts: 'quota.kind.tts',
};

const USED_KEY: Record<QuotaKind, I18nKey> = {
  chat: 'quota.used.chat',
  image: 'quota.used.image',
  stt: 'quota.used.stt',
  tts: 'quota.used.tts',
};

const STATUS_KEY: Record<'loading' | 'not_signed_in' | 'unreachable' | 'failed', I18nKey> = {
  loading: 'quota.me.loading',
  not_signed_in: 'quota.me.notSignedIn',
  unreachable: 'quota.me.unreachable',
  failed: 'quota.me.failed',
};

const loadQuotaMe = (signal: AbortSignal) => fetchQuotaMe((input, init) => runtimeFetch(input, init), signal);

export function QuotaMeView({ state, onReload }: { state: QuotaMeState; onReload: () => void }) {
  const { t } = useI18n();
  if (state.status === 'not_available') return null;
  const intlLocale = getCurrentIntlLocale();
  const numbers = new Intl.NumberFormat(intlLocale);

  return (
    <SettingsSection
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
        <div className="space-y-4">
          <p className={SETTINGS_HELPER_CLASS}>
            {t('quota.me.resets', { when: formatResetTime(state.quota.resetsAt, intlLocale) })}
          </p>
          {state.quota.lines.length === 0 ? (
            <p className={SETTINGS_HELPER_CLASS}>{t('quota.me.empty')}</p>
          ) : (
            <ul className="w-full max-w-[32rem] space-y-4">
              {state.quota.lines.map((line) => {
                const percent = usedPercent(line);
                return (
                  <li key={`${line.kind}:${line.modelKey}`} className="space-y-1.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                      <span className={cn(SETTINGS_FIELD_LABEL_CLASS, 'min-w-0 [overflow-wrap:anywhere]')}>
                        {line.label}
                        <span className="ml-2 typography-meta text-muted-foreground">{t(KIND_KEY[line.kind])}</span>
                      </span>
                      <span className="typography-meta tabular-nums text-muted-foreground">
                        {t(USED_KEY[line.kind], { used: numbers.format(line.used), limit: numbers.format(line.limit) })}
                      </span>
                    </div>
                    <div aria-label={t('quota.me.barAria', { model: line.label, percent: String(percent) })}>
                      <UsageProgressBar percent={percent} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        <p
          role={state.status === 'loading' ? 'status' : 'alert'}
          className={cn(SETTINGS_HELPER_CLASS, state.status !== 'loading' && 'text-[var(--status-warning)]')}
        >
          {t(STATUS_KEY[state.status])}
        </p>
      )}
    </SettingsSection>
  );
}

export const MittrQuotaSettings: React.FC<{ load?: (signal: AbortSignal) => Promise<QuotaMeResult> }> = ({
  load = loadQuotaMe,
}) => {
  const [state, setState] = React.useState<QuotaMeState>({ status: 'loading' });
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setState(result);
      },
      () => {
        if (!controller.signal.aborted) setState({ status: 'failed' });
      },
    );
    return () => controller.abort();
  }, [load, attempt]);

  const reload = React.useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((value) => value + 1);
  }, []);
  return <QuotaMeView state={state} onReload={reload} />;
};

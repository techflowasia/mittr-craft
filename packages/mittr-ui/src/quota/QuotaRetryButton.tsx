import React from 'react';

import { Icon } from '../../../ui/src/components/icon/Icon';
import { toast } from '../../../ui/src/components/ui';
import { Button } from '../../../ui/src/components/ui/button';
import type { ProductSlotProps } from '../../../ui/src/lib/product-plugins';
import { useMittrT } from '../strings/mittrT';
import { quotaExhaustedFromError } from './quotaError';
import { resendAfterQuota, sessionQuotaRetryDeps } from './resend';
import { useQuotaRetryPending } from './useQuotaRetryPending';

export function QuotaRetryButtonView({ busy, onRetry }: { busy: boolean; onRetry: () => void }): React.ReactNode {
  const t = useMittrT();
  return (
    <div className="mt-1">
      <Button type="button" variant="outline" size="xs" disabled={busy} aria-busy={busy} onClick={onRetry}>
        <Icon name={busy ? 'loader-4' : 'refresh'} aria-hidden="true" className={busy ? 'animate-spin motion-reduce:animate-none' : undefined} />
        {t('mittr.quota.exhausted.retry')}
      </Button>
    </div>
  );
}

export function QuotaRetryButton({ message, isLatestTurn }: ProductSlotProps['assistant-message-footer']): React.ReactNode {
  const t = useMittrT();
  const { busy, run } = useQuotaRetryPending(message.info.id);
  const { info } = message;
  if (!isLatestTurn || info.role !== 'assistant' || !info.error) return null;
  const { type, message: errorText, status, response } = info.error;
  if (!quotaExhaustedFromError({ type, message: errorText, status, responseBody: response?.body })) return null;

  const retry = () => {
    void run((pending) => resendAfterQuota(info, sessionQuotaRetryDeps(pending))).then((sent) => {
      if (sent === false) toast.error(t('mittr.quota.exhausted.retryFailed'));
    });
  };
  return <QuotaRetryButtonView busy={busy} onRetry={retry} />;
}

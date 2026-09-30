import type { Message } from '@opencode-ai/sdk/v2';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { resendQuotaPrompt, useQuotaRetryPending } from '@/lib/mittr-quota/resend';
import { isLatestInSession } from '@/lib/mittr-quota/retry';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessages } from '@/sync/sync-context';

export function QuotaRetryButtonView({ pending, onRetry }: { pending: boolean; onRetry: () => void }) {
    const { t } = useI18n();
    return (
        <Button
            type="button"
            variant="outline"
            size="xs"
            className="shrink-0"
            disabled={pending}
            aria-busy={pending}
            onClick={onRetry}
        >
            <Icon name={pending ? 'loader-4' : 'refresh'} aria-hidden="true" className={pending ? 'motion-safe:animate-spin' : undefined} />
            {t('quota.retry')}
        </Button>
    );
}

export function QuotaRetryButton({ assistant }: { assistant: Message }) {
    const directory = useSessionUIStore((state) => state.getDirectoryForSession(assistant.sessionID)) ?? undefined;
    const messages = useSessionMessages(assistant.sessionID, directory);
    const pending = useQuotaRetryPending((state) => Boolean(state.pending[assistant.id]));
    if (!isLatestInSession(messages, assistant.id)) return null;
    return (
        <QuotaRetryButtonView
            pending={pending}
            onRetry={() => {
                void resendQuotaPrompt(assistant);
            }}
        />
    );
}

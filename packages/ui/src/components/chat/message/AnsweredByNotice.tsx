import React from 'react';
import type { Message } from '@opencode-ai/sdk/v2';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { isMittrAnswer, substitutedAnswerOf, type AnsweredBy } from '@/lib/mittr-quota/answered-by';
import { useAnsweredByStore } from '@/lib/mittr-quota/answered-by-store';

export function AnsweredByNoticeView({ answer }: { answer: AnsweredBy }) {
    const { t } = useI18n();
    const values = { to: answer.answeredLabel, from: answer.requestedLabel };
    const text = answer.reason === 'quota'
        ? t('quota.answeredBy.outOfQuota', values)
        : t('quota.answeredBy.couldNotAnswer', values);
    return (
        <p className="mt-2 flex items-center gap-1.5 typography-meta text-muted-foreground" data-answered-by={answer.reason}>
            <Icon name="arrow-left-right" aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{text}</span>
        </p>
    );
}

export function AnsweredByNotice({ assistant }: { assistant: Message }) {
    const completedAt = isMittrAnswer(assistant) ? assistant.time.completed : undefined;
    const sessionId = assistant.sessionID;
    const list = useAnsweredByStore((state) => state.sessions[sessionId]);
    const load = useAnsweredByStore((state) => state.load);

    React.useEffect(() => {
        if (completedAt === undefined) return;
        void load(sessionId, completedAt);
    }, [completedAt, load, sessionId]);

    const answer = substitutedAnswerOf(assistant, list);
    return answer ? <AnsweredByNoticeView answer={answer} /> : null;
}

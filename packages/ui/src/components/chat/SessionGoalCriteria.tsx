import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { SessionGoalCriterion } from '@/lib/sessionGoalMetadata';
import { sessionGoalCriterionJudgeLabelKey, sessionGoalCriterionPresentation } from '@/lib/sessionGoalPresentation';
import { useI18n } from '@/lib/i18n';

interface SessionGoalCriteriaProps {
  criteria: SessionGoalCriterion[];
}

export function SessionGoalCriteria({ criteria }: SessionGoalCriteriaProps) {
  const { t } = useI18n();

  if (criteria.length === 0) {
    return (
      <p className="typography-meta text-muted-foreground">{t('chat.goal.criteria.pendingContract')}</p>
    );
  }

  return (
    <div className="space-y-1">
      <span className="typography-ui-label text-foreground">{t('chat.goal.criteria.title')}</span>
      <ul className="space-y-1.5">
        {criteria.map((criterion) => {
          const presentation = sessionGoalCriterionPresentation[criterion.status];
          const showReason = criterion.reason && criterion.status !== 'met';
          return (
            <li key={criterion.id} className="flex items-start gap-2">
              <Icon
                name={presentation.icon}
                className="mt-0.5 h-3.5 w-3.5 flex-shrink-0"
                style={{ color: presentation.color }}
                aria-label={t(presentation.labelKey as never)}
              />
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="break-words typography-meta text-foreground">{criterion.text}</p>
                {showReason ? (
                  <p className="break-words typography-micro text-muted-foreground">{criterion.reason}</p>
                ) : null}
                {criterion.by ? (
                  <p className="typography-micro text-muted-foreground">
                    {t(presentation.labelKey as never)}
                    {' · '}
                    {t(sessionGoalCriterionJudgeLabelKey[criterion.by] as never)}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

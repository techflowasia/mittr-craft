import type { IconName } from '@/components/icon/icons';
import type { SessionGoalCriterionJudge, SessionGoalCriterionStatus, SessionGoalStatus } from '@/lib/sessionGoalMetadata';

// Shared presentation mapping for the goal status across chat, sidebar and
// mobile surfaces. Colors are theme tokens; labels resolve through i18n at
// the call site.
export const sessionGoalStatusColor: Record<SessionGoalStatus, string> = {
  active: 'var(--status-info)',
  paused: 'var(--surface-muted-foreground)',
  blocked: 'var(--status-warning)',
  budgetLimited: 'var(--status-warning)',
  complete: 'var(--status-success)',
};

export const sessionGoalStatusLabelKey: Record<SessionGoalStatus, string> = {
  active: 'chat.goal.status.active',
  paused: 'chat.goal.status.paused',
  blocked: 'chat.goal.status.blocked',
  budgetLimited: 'chat.goal.status.budgetLimited',
  complete: 'chat.goal.status.complete',
};

export const sessionGoalCriterionPresentation: Record<SessionGoalCriterionStatus, { icon: IconName; color: string; labelKey: string }> = {
  met: { icon: 'checkbox-circle', color: 'var(--status-success)', labelKey: 'chat.goal.criteria.status.met' },
  missing: { icon: 'close-circle', color: 'var(--status-warning)', labelKey: 'chat.goal.criteria.status.missing' },
  needs_person: { icon: 'user', color: 'var(--status-info)', labelKey: 'chat.goal.criteria.status.needsPerson' },
  pending: { icon: 'time', color: 'var(--surface-muted-foreground)', labelKey: 'chat.goal.criteria.status.pending' },
};

export const sessionGoalCriterionJudgeLabelKey: Record<Exclude<SessionGoalCriterionJudge, ''>, string> = {
  script: 'chat.goal.criteria.checkedBy.script',
  mittr: 'chat.goal.criteria.checkedBy.mittr',
  model: 'chat.goal.criteria.checkedBy.model',
};

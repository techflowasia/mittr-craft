import { useI18n } from '@/lib/i18n';

/**
 * Recording what somebody types and not telling them is the version of the
 * audit trail that damages trust, so the notice is part of the feature rather
 * than decoration around it (spec §8).
 *
 * Both halves of the sentence carry weight. Without the second one the notice
 * reads as though everything is captured, and people quietly stop using the
 * product for real work.
 */
export function AuditNotice({ className = '' }: { className?: string }) {
  const { t } = useI18n();
  return (
    <p role="note" className={`text-xs text-muted-foreground ${className}`.trim()}>
      {t('mittr.audit.notice')}
    </p>
  );
}

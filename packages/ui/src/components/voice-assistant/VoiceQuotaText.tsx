import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { formatResetTime } from '@/lib/mittr-quota/week';
import type { VoiceQuotaNotice } from '@/lib/voice-assistant/session';

export function VoiceQuotaText({ notice }: { notice: VoiceQuotaNotice }) {
  const { t } = useI18n();
  const when = formatResetTime(notice.resetsAt, getCurrentIntlLocale());
  if (notice.kind === 'stt') return <>{t('quota.stt.exhausted', { when })}</>;
  if (notice.kind === 'tts') return <>{t('quota.tts.exhausted')}</>;
  return <>{t('quota.exhausted', { when })}</>;
}

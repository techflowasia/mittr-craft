import React from 'react';

import { formatResetTime, PRODUCT_LOCALE, PRODUCT_TIME_ZONE } from '../quota/agentStatus';
import { useMittrT } from '../strings/mittrT';
import type { VoiceQuotaNotice } from './voiceSession';

export function VoiceQuotaText({ notice }: { notice: VoiceQuotaNotice }): React.ReactNode {
  const t = useMittrT();
  const when = formatResetTime(notice.resetsAt, PRODUCT_LOCALE, PRODUCT_TIME_ZONE);
  if (notice.kind === 'stt') return <>{t('mittr.speech.sttExhausted', { when })}</>;
  if (notice.kind === 'tts') return <>{t('mittr.speech.ttsExhausted')}</>;
  return <>{t('mittr.quota.exhausted.chat', { when })}</>;
}

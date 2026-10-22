import React from 'react';

import type { DictationBlock } from '../../../ui/src/lib/product-plugins';
import { useConfigStore } from '../../../ui/src/stores/useConfigStore';
import { formatResetTime, PRODUCT_LOCALE, PRODUCT_TIME_ZONE } from '../quota/agentStatus';
import { mittrT, type MittrKey } from '../strings/mittrT';
import { useSpeechQuotaBlock } from './speechQuotaStore';
import { useTalkState } from './talkStore';
import { mittrDictationOn } from './upstreamSpeech';
import type { VoiceReadiness, VoiceReadinessReason } from './voiceApi';

const NOT_BLOCKED: DictationBlock = { blocked: false };

const LISTEN_REASON = {
  not_signed_in: 'mittr.voice.settings.mittr.reason.not_signed_in',
  not_configured: 'mittr.voice.settings.mittr.reason.not_configured',
  unreachable: 'mittr.voice.settings.mittr.reason.unreachable',
} satisfies Record<VoiceReadinessReason, MittrKey>;

export interface DictationBlockInput {
  mittrOn: boolean;
  sttBlockedUntil: string | null;
  readiness: VoiceReadiness | null;
}

export function dictationBlockOf(input: DictationBlockInput): DictationBlock {
  if (!input.mittrOn) return NOT_BLOCKED;
  if (input.sttBlockedUntil) {
    return {
      blocked: true,
      reason: mittrT('mittr.speech.sttExhausted', { when: formatResetTime(input.sttBlockedUntil, PRODUCT_LOCALE, PRODUCT_TIME_ZONE) }),
    };
  }
  if (input.readiness && !input.readiness.listen) {
    return { blocked: true, reason: mittrT(LISTEN_REASON[input.readiness.reason ?? 'not_configured']) };
  }
  return NOT_BLOCKED;
}

export function useMittrDictationBlock(): DictationBlock {
  const mittrOn = useConfigStore((state) => mittrDictationOn(state));
  const sttBlockedUntil = useSpeechQuotaBlock('stt');
  const readiness = useTalkState((state) => state.readiness);
  return React.useMemo(() => dictationBlockOf({ mittrOn, sttBlockedUntil, readiness }), [mittrOn, sttBlockedUntil, readiness]);
}

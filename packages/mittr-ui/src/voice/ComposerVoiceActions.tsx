import React from 'react';

import { isVSCodeRuntime } from '../../../ui/src/lib/desktop';
import { isDictationCaptureSupported } from '../../../ui/src/lib/dictation/use-dictation-audio-source';
import type { ProductSlotProps } from '../../../ui/src/lib/product-plugins';
import { useMittrSurface } from '../mittrSurface';
import { ComposerTalkButton } from './TalkButton';
import { useTalkState } from './talkStore';
import { useNarratorClaim } from './narratorClaim';
import { VoiceNarrator } from './VoiceNarrator';
import { useMittrDictationBlock } from './useMittrDictationBlock';

export function ComposerVoiceActions({ footerIconButtonClass, iconSizeClass }: ProductSlotProps['composer-actions']): React.ReactNode {
  const surface = useMittrSurface();
  const [supported] = React.useState(() => !isVSCodeRuntime() && isDictationCaptureSupported());
  const block = useMittrDictationBlock();
  const narrating = useNarratorClaim();
  const open = useTalkState((state) => state.phase !== 'idle');
  if (!surface || !supported) return null;
  return (
    <>
      {narrating && open ? <VoiceNarrator /> : null}
      {block.blocked && block.reason ? (
        <span role="status" title={block.reason} className="max-w-[14rem] truncate typography-micro text-[var(--status-warning)]">
          {block.reason}
        </span>
      ) : null}
      <ComposerTalkButton className={footerIconButtonClass} iconClassName={iconSizeClass} />
    </>
  );
}

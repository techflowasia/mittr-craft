import React from 'react';

import { Icon } from '../../../ui/src/components/icon/Icon';
import { cn } from '../../../ui/src/lib/utils';
import { formatResetTime, PRODUCT_LOCALE, PRODUCT_TIME_ZONE } from '../quota/agentStatus';
import { useMittrT } from '../strings/mittrT';
import { useSpeechQuotaBlock } from './speechQuotaStore';
import { talkStore, useTalkState } from './talkStore';
import { isTalkReady, type VoiceReadiness } from './voiceApi';
import type { VoicePhase } from './voiceSession';

export function TalkIcon({ className }: { className?: string }): React.ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      data-mittr-icon="talk"
      className={className}
    >
      <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" />
    </svg>
  );
}

export interface TalkButtonProps {
  readiness: VoiceReadiness | null;
  phase: VoicePhase;
  onToggle: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
  className?: string;
  iconClassName?: string;
  voiceInputBlockedUntil?: string | null;
}

export function TalkButton({
  readiness,
  phase,
  onToggle,
  buttonRef,
  className,
  iconClassName,
  voiceInputBlockedUntil = null,
}: TalkButtonProps): React.ReactNode {
  const t = useMittrT();
  const open = phase !== 'idle';
  if (!open && !isTalkReady(readiness)) return null;
  if (!open && voiceInputBlockedUntil) {
    const blocked = t('mittr.speech.sttExhausted', { when: formatResetTime(voiceInputBlockedUntil, PRODUCT_LOCALE, PRODUCT_TIME_ZONE) });
    return (
      <button
        ref={buttonRef}
        type="button"
        disabled
        aria-label={blocked}
        title={blocked}
        className={cn(className, 'cursor-not-allowed opacity-50')}
      >
        <TalkIcon className={cn(iconClassName, 'text-current')} />
      </button>
    );
  }
  const label = t(open ? 'mittr.voice.talk.end' : 'mittr.voice.talk.start');
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      aria-busy={phase === 'starting'}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
      className={cn(className, open && 'text-primary')}
    >
      {phase === 'starting' ? (
        <Icon name="loader-4" aria-hidden="true" className={cn(iconClassName, 'motion-safe:animate-spin')} />
      ) : (
        <TalkIcon className={cn(iconClassName, 'text-current')} />
      )}
    </button>
  );
}

const registerTalkButton = (element: HTMLButtonElement | null) => {
  if (element) talkStore.setState({ button: element });
  else if (talkStore.getState().button?.isConnected === false) talkStore.setState({ button: null });
};

export function ComposerTalkButton({ className, iconClassName }: { className?: string; iconClassName?: string }): React.ReactNode {
  const readiness = useTalkState((state) => state.readiness);
  const phase = useTalkState((state) => state.phase);
  const toggle = useTalkState((state) => state.toggle);
  const voiceInputBlockedUntil = useSpeechQuotaBlock('stt');
  return (
    <TalkButton
      readiness={readiness}
      phase={phase}
      onToggle={toggle}
      voiceInputBlockedUntil={voiceInputBlockedUntil}
      buttonRef={registerTalkButton}
      className={className}
      iconClassName={iconClassName}
    />
  );
}

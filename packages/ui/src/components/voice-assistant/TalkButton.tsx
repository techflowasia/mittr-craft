import React from 'react';
import { Icon } from '@/components/icon/Icon';
import {
  parseAuthorizeUrl,
  SIGN_IN_COMPLETED_EVENT,
  SIGN_IN_START_ENDPOINT,
} from '@/components/mittr/mittrSignInGateState';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { speechBlockedUntil, useSpeechQuotaBlock, useSpeechQuotaStore } from '@/lib/mittr-quota/speech-quota-store';
import { formatResetTime } from '@/lib/mittr-quota/week';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { cn } from '@/lib/utils';
import { bindEscapeToEnd } from '@/lib/voice-assistant/keys';
import { startConversationListening } from '@/lib/voice-assistant/listen';
import { createNarrationWatch, spokenText, type NarrationWatch, type SessionError } from '@/lib/voice-assistant/narration';
import { createAudioPlayer } from '@/lib/voice-assistant/player';
import { queueSpokenPrompt, queuedPromptCount } from '@/lib/voice-assistant/queue';
import { VoiceSession, type VoicePhase } from '@/lib/voice-assistant/session';
import { useTalkStore } from '@/lib/voice-assistant/talk-store';
import { createVoiceApi, isTalkReady, type VoiceReadiness } from '@/lib/voice-assistant/turn';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useNotificationStore } from '@/sync/notification-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionPermissions, useSessionStatus } from '@/sync/sync-context';
import { VoiceBar } from './VoiceBar';
import { VoiceQuotaText } from './VoiceQuotaText';

const READINESS_REFRESH_MS = 60_000;

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
}: TalkButtonProps) {
  const { t } = useI18n();
  const open = phase !== 'idle';
  if (!open && !isTalkReady(readiness)) return null;
  if (!open && voiceInputBlockedUntil) {
    const blocked = t('quota.stt.exhausted', { when: formatResetTime(voiceInputBlockedUntil, getCurrentIntlLocale()) });
    return (
      <button
        ref={buttonRef}
        type="button"
        disabled
        aria-label={blocked}
        title={blocked}
        className={cn(className, 'cursor-not-allowed opacity-50')}
      >
        <Icon name="voiceprint" aria-hidden="true" className={cn(iconClassName, 'text-current')} />
      </button>
    );
  }
  const label = t(open ? 'voice.talk.end' : 'voice.talk.start');
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
        <Icon name="voiceprint" aria-hidden="true" className={cn(iconClassName, 'text-current')} />
      )}
    </button>
  );
}

const registerTalkButton = (element: HTMLButtonElement | null) => {
  if (element) useTalkStore.setState({ button: element });
  else if (useTalkStore.getState().button?.isConnected === false) useTalkStore.setState({ button: null });
};

export function ComposerTalkButton({ className, iconClassName }: { className?: string; iconClassName?: string }) {
  const readiness = useTalkStore((state) => state.readiness);
  const phase = useTalkStore((state) => state.phase);
  const toggle = useTalkStore((state) => state.toggle);
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

const voiceApi = createVoiceApi((input, init) => runtimeFetch(input, init));

function browserPlayer() {
  const context = new AudioContext();
  void context.resume().catch(() => {});
  return {
    player: createAudioPlayer(context),
    close: () => {
      void context.close().catch(() => {});
    },
  };
}

function openSession() {
  const { currentSessionId, currentSessionDirectory } = useSessionUIStore.getState();
  const directory = currentSessionDirectory ?? useDirectoryStore.getState().currentDirectory ?? undefined;
  const queuedPrompts = queuedPromptCount(currentSessionId, directory);
  return {
    ...(directory ? { directory } : {}),
    ...(currentSessionId ? { sessionId: currentSessionId } : {}),
    ...(queuedPrompts !== undefined ? { queuedPrompts } : {}),
  };
}

async function startMittrSignIn(): Promise<void> {
  try {
    const response = await runtimeFetch(SIGN_IN_START_ENDPOINT, { method: 'POST' });
    const authorizeUrl = parseAuthorizeUrl(await response.json());
    if (authorizeUrl) window.open(authorizeUrl, '_blank', 'noopener,noreferrer');
  } catch {
    return;
  }
}

function useVoiceReadiness(): [VoiceReadiness | null, () => void] {
  const [readiness, setReadiness] = React.useState<VoiceReadiness | null>(null);
  const refresh = React.useCallback(() => {
    void voiceApi.readiness().then(setReadiness);
  }, []);
  React.useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, READINESS_REFRESH_MS);
    window.addEventListener('focus', refresh);
    window.addEventListener(SIGN_IN_COMPLETED_EVENT, refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener(SIGN_IN_COMPLETED_EVENT, refresh);
    };
  }, [refresh]);
  return [readiness, refresh];
}

function latestErrorKey(sessionId: string | null) {
  return (state: ReturnType<typeof useNotificationStore.getState>): string => {
    if (!sessionId) return '';
    for (let i = state.list.length - 1; i >= 0; i -= 1) {
      const entry = state.list[i];
      if (entry?.session !== sessionId || entry.type !== 'error') continue;
      const name = (entry.error as { name?: unknown } | undefined)?.name;
      return `${entry.time}:${name === 'MessageAbortedError' ? 'aborted' : 'failed'}`;
    }
    return '';
  };
}

function parseErrorKey(key: string): SessionError | null {
  if (!key) return null;
  const [at, kind] = key.split(':');
  return { at: Number(at), aborted: kind === 'aborted' };
}

function Narrator({ session }: { session: VoiceSession }) {
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const directory = useSessionUIStore((state) => state.currentSessionDirectory) ?? undefined;
  const status = useSessionStatus(sessionId ?? '', directory);
  const permissions = useSessionPermissions(sessionId ?? '', directory);
  const errorKey = useNotificationStore(React.useMemo(() => latestErrorKey(sessionId), [sessionId]));
  const watch = React.useRef<NarrationWatch | null>(null);
  if (!watch.current) watch.current = createNarrationWatch();

  const busy = status?.type === 'busy' || status?.type === 'retry';
  const permissionKey = permissions.map((request) => request.id).join('\n');

  React.useEffect(() => {
    const events = watch.current!.observe({
      sessionId,
      busy,
      permissionIds: permissionKey ? permissionKey.split('\n') : [],
      error: parseErrorKey(errorKey),
    });
    for (const event of events) session.narrate(spokenText(event), event);
  }, [session, sessionId, busy, permissionKey, errorKey]);

  return null;
}

export function VoiceAssistant() {
  const [readiness, refreshReadiness] = useVoiceReadiness();
  const [session] = React.useState(
    () =>
      new VoiceSession({
        listen: startConversationListening,
        transcribe: voiceApi.transcribe,
        turn: voiceApi.turn,
        synthesize: voiceApi.synthesize,
        createPlayer: browserPlayer,
        context: openSession,
        onQueue: (event) => {
          queueSpokenPrompt(event);
        },
        onEnd: () => {
          void voiceApi.end();
        },
        onQuota: (kind, resetsAt) => {
          useSpeechQuotaStore.getState().block(kind, resetsAt);
        },
      }),
  );
  const snapshot = React.useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const open = snapshot.phase !== 'idle';

  React.useEffect(() => {
    const leave = () => session.end();
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      session.end();
    };
  }, [session]);

  const ready = isTalkReady(readiness);

  const end = React.useCallback(() => {
    session.end();
    useTalkStore.getState().button?.focus();
  }, [session]);

  React.useEffect(() => {
    if (!open) return;
    return bindEscapeToEnd(window, end);
  }, [open, end]);

  const toggle = React.useCallback(() => {
    if (open) {
      end();
      return;
    }
    if (!readiness || speechBlockedUntil('stt')) return;
    void session.start({ silenceMs: readiness.voiceSilenceMs });
  }, [end, open, readiness, session]);

  React.useEffect(() => {
    useTalkStore.setState({ readiness, phase: snapshot.phase, toggle });
  }, [readiness, snapshot.phase, toggle]);

  if (!ready && !open) return null;

  return (
    <div className="pointer-events-none fixed bottom-48 right-4 z-40 flex flex-col items-end gap-2">
      {open ? (
        <>
          <Narrator session={session} />
          <VoiceBar
            snapshot={snapshot}
            onEnd={end}
            onSignIn={() => {
              void startMittrSignIn().then(refreshReadiness);
            }}
            className="pointer-events-auto"
          />
        </>
      ) : null}
      {!open && snapshot.error ? (
        <p role="alert" className="pointer-events-auto max-w-[16rem] rounded-md bg-[var(--surface-elevated)] px-2 py-1 typography-micro text-[var(--status-error)] shadow-sm">
          <ErrorText error={snapshot.error} />
        </p>
      ) : null}
      {!open && !snapshot.error && snapshot.quota ? (
        <p role="alert" className="pointer-events-auto max-w-[16rem] rounded-md bg-[var(--surface-elevated)] px-2 py-1 typography-micro text-[var(--status-warning)] shadow-sm">
          <VoiceQuotaText notice={snapshot.quota} />
        </p>
      ) : null}
    </div>
  );
}

function ErrorText({ error }: { error: NonNullable<ReturnType<VoiceSession['getSnapshot']>['error']> }) {
  const { t } = useI18n();
  return <>{t(error)}</>;
}

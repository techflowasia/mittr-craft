import React from 'react';
import { Icon } from '@/components/icon/Icon';
import {
  parseAuthorizeUrl,
  SIGN_IN_COMPLETED_EVENT,
  SIGN_IN_START_ENDPOINT,
} from '@/components/mittr/mittrSignInGateState';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { cn } from '@/lib/utils';
import { startConversationListening } from '@/lib/voice-assistant/listen';
import { createNarrationWatch, spokenText, type NarrationWatch } from '@/lib/voice-assistant/narration';
import { createAudioPlayer } from '@/lib/voice-assistant/player';
import { queueSpokenPrompt, queuedPromptCount } from '@/lib/voice-assistant/queue';
import { VoiceSession, type VoicePhase } from '@/lib/voice-assistant/session';
import { createVoiceApi, isTalkReady, type VoiceReadiness } from '@/lib/voice-assistant/turn';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useNotificationStore } from '@/sync/notification-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionPermissions, useSessionStatus } from '@/sync/sync-context';
import { VoiceBar } from './VoiceBar';

const READINESS_REFRESH_MS = 60_000;

export interface TalkButtonProps {
  readiness: VoiceReadiness | null;
  phase: VoicePhase;
  onToggle: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
  className?: string;
}

export function TalkButton({ readiness, phase, onToggle, buttonRef, className }: TalkButtonProps) {
  const { t } = useI18n();
  const open = phase !== 'idle';
  if (!open && !isTalkReady(readiness)) return null;
  const label = t(open ? 'voice.talk.end' : 'voice.talk.start');
  return (
    <Button
      ref={buttonRef}
      type="button"
      variant={open ? 'default' : 'outline'}
      size="icon"
      aria-label={label}
      aria-pressed={open}
      aria-busy={phase === 'starting'}
      title={label}
      onClick={onToggle}
      className={cn('rounded-full shadow-md', className)}
    >
      {phase === 'starting' ? (
        <Icon name="loader-4" aria-hidden="true" className="motion-safe:animate-spin" />
      ) : (
        <Icon name="mic" aria-hidden="true" />
      )}
    </Button>
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

function latestErrorAt(sessionId: string | null) {
  return (state: ReturnType<typeof useNotificationStore.getState>): number | null => {
    if (!sessionId) return null;
    for (let i = state.list.length - 1; i >= 0; i -= 1) {
      const entry = state.list[i];
      if (entry?.session === sessionId && entry.type === 'error') return entry.time;
    }
    return null;
  };
}

function Narrator({ session }: { session: VoiceSession }) {
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const directory = useSessionUIStore((state) => state.currentSessionDirectory) ?? undefined;
  const status = useSessionStatus(sessionId ?? '', directory);
  const permissions = useSessionPermissions(sessionId ?? '', directory);
  const errorAt = useNotificationStore(React.useMemo(() => latestErrorAt(sessionId), [sessionId]));
  const watch = React.useRef<NarrationWatch | null>(null);
  if (!watch.current) watch.current = createNarrationWatch();

  const busy = status?.type === 'busy' || status?.type === 'retry';
  const permissionKey = permissions.map((request) => request.id).join('\n');

  React.useEffect(() => {
    const events = watch.current!.observe({
      sessionId,
      busy,
      permissionIds: permissionKey ? permissionKey.split('\n') : [],
      errorAt,
    });
    for (const event of events) session.narrate(spokenText(event));
  }, [session, sessionId, busy, permissionKey, errorAt]);

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
      }),
  );
  const snapshot = React.useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const talk = React.useRef<HTMLButtonElement | null>(null);
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
    talk.current?.focus();
  }, [session]);

  const toggle = React.useCallback(() => {
    if (open) {
      end();
      return;
    }
    if (!readiness) return;
    void session.start({ silenceMs: readiness.voiceSilenceMs });
  }, [end, open, readiness, session]);

  if (!ready && !open) return null;

  return (
    <div className="pointer-events-none fixed bottom-24 right-4 z-40 flex flex-col items-end gap-2">
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
      <TalkButton
        readiness={readiness}
        phase={snapshot.phase}
        onToggle={toggle}
        buttonRef={talk}
        className="pointer-events-auto"
      />
    </div>
  );
}

function ErrorText({ error }: { error: NonNullable<ReturnType<VoiceSession['getSnapshot']>['error']> }) {
  const { t } = useI18n();
  return <>{t(error)}</>;
}

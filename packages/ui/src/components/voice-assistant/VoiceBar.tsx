import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { VoicePhase, VoiceSnapshot } from '@/lib/voice-assistant/session';

const STATE: Record<Exclude<VoicePhase, 'idle'>, I18nKey> = {
  starting: 'voice.talk.listening',
  listening: 'voice.talk.listening',
  thinking: 'voice.talk.thinking',
  speaking: 'voice.talk.speaking',
};

const DOT: Record<Exclude<VoicePhase, 'idle'>, string> = {
  starting: 'bg-muted-foreground',
  listening: 'bg-[var(--status-success)]',
  thinking: 'bg-[var(--status-warning)]',
  speaking: 'bg-[var(--primary-base)]',
};

export interface VoiceBarProps {
  snapshot: VoiceSnapshot;
  onEnd: () => void;
  onSignIn: () => void;
  className?: string;
}

export function VoiceBar({ snapshot, onEnd, onSignIn, className }: VoiceBarProps) {
  const { t } = useI18n();
  const list = React.useRef<HTMLOListElement | null>(null);
  const lines = snapshot.transcript;

  React.useEffect(() => {
    const node = list.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines]);

  if (snapshot.phase === 'idle') return null;
  const phase = snapshot.phase;
  const last = lines.at(-1);
  const finished =
    last && ((phase === 'listening' && !snapshot.hearing) || (phase === 'thinking' && last.role === 'user')) ? last : null;
  const announcement = finished
    ? `${t(finished.role === 'user' ? 'voice.talk.you' : 'voice.talk.assistant')}: ${finished.text}`
    : '';

  return (
    <section
      aria-label={t('voice.talk.label')}
      className={cn(
        'flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-3 text-foreground shadow-lg',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span role="status" aria-atomic="true" className="flex min-w-0 flex-1 items-center gap-2 typography-meta">
          <span
            aria-hidden="true"
            className={cn(
              'size-2 shrink-0 rounded-full',
              DOT[phase],
              snapshot.hearing && 'motion-safe:animate-pulse',
            )}
          />
          <span className="truncate">{t(STATE[phase])}</span>
        </span>
        <Button type="button" variant="destructive" size="sm" onClick={onEnd}>
          <Icon name="stop" aria-hidden="true" />
          {t('voice.talk.end')}
        </Button>
      </div>
      {snapshot.running ? (
        <p className="flex items-center gap-1.5 typography-micro text-muted-foreground">
          <Icon name="loader-4" aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{t('voice.talk.running', { label: snapshot.running })}</span>
        </p>
      ) : null}
      {snapshot.error ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 typography-meta text-[var(--status-error)]">
          <span className="min-w-0 flex-1">{t(snapshot.error)}</span>
          {snapshot.error === 'voice.talk.error.notSignedIn' ? (
            <Button type="button" variant="outline" size="xs" onClick={onSignIn}>
              {t('mittr.signIn.action')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <p data-voice-announce="true" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>
      {lines.length ? (
        <ol
          ref={list}
          role="log"
          aria-live="off"
          className="flex max-h-56 flex-col gap-1.5 overflow-y-auto pr-1"
        >
          {lines.map((line) => (
            <li key={line.id} className="flex flex-col gap-0.5">
              <span
                className={cn(
                  'typography-micro font-medium',
                  line.role === 'user' ? 'text-muted-foreground' : 'text-[var(--primary-base)]',
                )}
              >
                {t(line.role === 'user' ? 'voice.talk.you' : 'voice.talk.assistant')}
              </span>
              <span className="typography-meta [overflow-wrap:anywhere]">{line.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

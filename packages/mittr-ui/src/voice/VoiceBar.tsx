import React from 'react';

import { Icon } from '../../../ui/src/components/icon/Icon';
import { Button } from '../../../ui/src/components/ui/button';
import { cn } from '../../../ui/src/lib/utils';
import type { MittrKey } from '../strings/mittrT';
import { useMittrT } from '../strings/mittrT';
import { VoiceQuotaText } from './VoiceQuotaText';
import type { VoicePhase, VoiceSnapshot } from './voiceSession';

type OpenPhase = Exclude<VoicePhase, 'idle'>;

const STATE = {
  starting: 'mittr.voice.talk.listening',
  listening: 'mittr.voice.talk.listening',
  thinking: 'mittr.voice.talk.thinking',
  speaking: 'mittr.voice.talk.speaking',
} satisfies Record<OpenPhase, MittrKey>;

const DOT = {
  starting: 'var(--muted-foreground)',
  listening: 'var(--status-success)',
  thinking: 'var(--status-warning)',
  speaking: 'var(--primary-base)',
} satisfies Record<OpenPhase, string>;

export interface VoiceBarProps {
  snapshot: VoiceSnapshot;
  onEnd: () => void;
  className?: string;
}

export function VoiceBar({ snapshot, onEnd, className }: VoiceBarProps): React.ReactNode {
  const t = useMittrT();
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
    ? `${t(finished.role === 'user' ? 'mittr.voice.talk.you' : 'mittr.voice.talk.assistant')}: ${finished.text}`
    : '';

  return (
    <section
      aria-label={t('mittr.voice.talk.label')}
      className={cn(
        'flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-3 text-foreground shadow-lg',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span role="status" aria-atomic="true" className="flex min-w-0 flex-1 items-center gap-2 typography-meta">
          <span
            aria-hidden="true"
            className={cn('size-2 shrink-0 rounded-full', snapshot.hearing && 'animate-pulse motion-reduce:animate-none')}
            style={{ backgroundColor: DOT[phase] }}
          />
          <span className="truncate">{t(STATE[phase])}</span>
        </span>
        <Button type="button" variant="destructive" size="sm" onClick={onEnd}>
          <Icon name="stop" aria-hidden="true" />
          {t('mittr.voice.talk.end')}
        </Button>
      </div>
      {snapshot.running ? (
        <p className="flex items-center gap-1.5 typography-micro text-muted-foreground">
          <Icon name="loader-4" aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{t('mittr.voice.talk.running', { label: snapshot.running })}</span>
        </p>
      ) : null}
      {snapshot.error ? (
        <p role="alert" className="typography-meta text-[var(--status-error)]">
          {t(snapshot.error)}
        </p>
      ) : null}
      {snapshot.quota ? (
        <p role="status" className="typography-meta text-[var(--status-warning)]">
          <VoiceQuotaText notice={snapshot.quota} />
        </p>
      ) : null}
      <p data-voice-announce="true" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>
      {lines.length ? (
        <ol ref={list} role="log" aria-live="off" className="flex max-h-56 flex-col gap-1.5 overflow-y-auto pr-1">
          {lines.map((line) => (
            <li key={line.id} className="flex flex-col gap-0.5">
              <span
                className={cn(
                  'typography-micro font-medium',
                  line.role === 'user' ? 'text-muted-foreground' : 'text-[var(--primary-base)]',
                )}
              >
                {t(line.role === 'user' ? 'mittr.voice.talk.you' : 'mittr.voice.talk.assistant')}
              </span>
              <span className="typography-meta [overflow-wrap:anywhere]">{line.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

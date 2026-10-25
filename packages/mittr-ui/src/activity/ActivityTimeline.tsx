import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { copyTextToClipboard } from '@/lib/clipboard';
import { getCurrentIntlLocale } from '@/lib/i18n';
import type { TimeFormatPreference } from '@/stores/useUIStore';
import { mittrT } from '../strings/mittrT';
import {
  orphanChildren,
  readCreated,
  readSpawnedSessionIds,
  readTokenCounts,
  stepLabel,
  stepTiming,
  timelineTurns,
  type ChildSession,
  type SessionMessage,
} from './activityModel';
import { deriveUserSnippet, formatMessagePreviewClock, formatMessagePreviewDay } from './rawMessagePreview';

const WorkerHighlightedCode = React.lazy(() => import('@/components/code/WorkerHighlightedCode').then((module) => ({ default: module.WorkerHighlightedCode })));

export type ActivityTimelineProps = {
  messages: SessionMessage[];
  childSessions: ChildSession[];
  onOpenChild: (childId: string, label: string) => void;
  timeFormatPreference: TimeFormatPreference;
  sessionKey: string;
};

const COPY_FEEDBACK_MS = 1500;

const formatNumber = (value: number): string => value.toLocaleString(getCurrentIntlLocale());

const SPINE_GRADIENT = 'var(--grad-brand, linear-gradient(to bottom, var(--primary-base), var(--primary-muted)))';
const DOT_GRADIENT = 'var(--grad-accent, var(--primary-base))';

const Spine: React.FC<{ variant: 'full' | 'half'; inset?: boolean }> = ({ variant, inset = false }) => (
  <span
    aria-hidden="true"
    style={{
      position: 'absolute',
      top: 0,
      left: inset ? 3 : 4,
      width: 2,
      height: variant === 'full' ? '100%' : '1.25rem',
      borderRadius: 9999,
      opacity: 0.7,
      backgroundImage: SPINE_GRADIENT,
    }}
  />
);

type DotTone = 'prompt' | 'step' | 'running' | 'child';

const DOT_STYLE = {
  prompt: { top: '0.45rem', width: 11, height: 11, backgroundImage: DOT_GRADIENT, boxShadow: '0 0 0 3px var(--surface-background), 0 0 10px var(--primary-muted)' },
  step: { top: '0.5rem', width: 10, height: 10, backgroundImage: DOT_GRADIENT, boxShadow: '0 0 0 3px var(--surface-background), 0 0 8px var(--primary-muted)' },
  running: { top: '0.5rem', width: 10, height: 10, backgroundImage: DOT_GRADIENT, boxShadow: '0 0 0 3px var(--surface-background), 0 0 12px var(--primary-base)' },
  child: { top: '0.45rem', width: 8, height: 8, background: 'var(--primary-muted)', boxShadow: '0 0 0 3px var(--surface-background)' },
} satisfies Record<DotTone, React.CSSProperties>;

const Dot: React.FC<{ tone: DotTone }> = ({ tone }) => (
  <span
    aria-hidden="true"
    className={tone === 'running' ? 'animate-pulse' : undefined}
    style={{ position: 'absolute', left: 0, borderRadius: 9999, ...DOT_STYLE[tone] }}
  />
);

const ChildBranch: React.FC<{ sessions: ChildSession[]; onOpen: (id: string, label: string) => void }> = ({ sessions, onOpen }) => {
  if (sessions.length === 0) return null;
  return (
    <div style={{ marginTop: 4, marginBottom: 4, marginLeft: '1.75rem' }}>
      {sessions.map((child) => {
        const label = child.title?.trim() || mittrT('mittr.activity.subagentUntitled');
        return (
          <div style={{ position: 'relative' }} key={child.id}>
            <Spine variant="full" inset />
            <Dot tone="child" />
            <button
              type="button"
              className="w-full cursor-pointer rounded-md text-left transition-colors hover:bg-interactive-hover"
              style={{ padding: '0.375rem 0.5rem 0.375rem 1.5rem' }}
              onClick={() => onOpen(child.id, label)}
            >
              <div className="typography-meta text-foreground">{label}</div>
              <div className="typography-micro text-muted-foreground" style={{ marginTop: 2 }}>
                {mittrT('mittr.activity.subagent')}
              </div>
            </button>
          </div>
        );
      })}
    </div>
  );
};

type StepRowProps = {
  message: SessionMessage;
  spawned: ChildSession[];
  onOpenChild: (childId: string, label: string) => void;
  index: number;
  total: number;
  isExpanded: boolean;
  isCopied: boolean;
  onToggle: () => void;
  onCopy: (json: string) => void;
};

const StepRow: React.FC<StepRowProps> = ({
  message, spawned, onOpenChild, index, total, isExpanded, isCopied, onToggle, onCopy,
}) => {
  const label = stepLabel(message);
  const { running, duration } = stepTiming(message);
  const tokens = readTokenCounts(message);
  const who = message.info.role === 'assistant' ? [message.info.agent, message.info.modelID].filter(Boolean).join(' · ') : '';
  const json = isExpanded ? JSON.stringify({ info: message.info, parts: message.parts }, null, 2) : '';

  return (
    <div style={{ position: 'relative' }}>
      <Spine variant="full" />
      <Dot tone={running ? 'running' : 'step'} />
      <div className="overflow-hidden rounded-lg">
        <button
          type="button"
          className="w-full cursor-pointer rounded-lg text-left transition-colors hover:bg-interactive-hover"
          style={{ padding: '0.625rem 0.75rem 0.625rem 1.75rem' }}
          aria-expanded={isExpanded}
          onClick={onToggle}
        >
          <div className="typography-ui-header font-medium text-foreground">
            {label.primary || '—'}
            {label.ambient && (
              <span className="typography-meta font-normal text-muted-foreground">
                {' · '}
                {label.ambient}
              </span>
            )}
          </div>

          {running ? (
            <div className="typography-meta" style={{ marginTop: 4, color: 'var(--primary-base)' }}>
              {mittrT('mittr.activity.working')}
            </div>
          ) : (
            duration && (
              <div className="typography-meta text-muted-foreground tabular-nums" style={{ marginTop: 4 }}>
                {mittrT('mittr.activity.elapsed', { duration })}
              </div>
            )
          )}

          <div className="typography-micro text-muted-foreground" style={{ marginTop: 6 }}>
            {mittrT('mittr.activity.step', { index, total })}
          </div>

          {who && (
            <div className="typography-micro text-muted-foreground" style={{ marginTop: 2 }}>
              {who}
            </div>
          )}

          {tokens && (
            <div
              className="typography-micro text-muted-foreground tabular-nums"
              style={{ marginTop: 2 }}
              aria-label={mittrT('mittr.activity.tokensAria', { input: formatNumber(tokens.input), output: formatNumber(tokens.output) })}
            >
              {mittrT('mittr.activity.tokens', { input: formatNumber(tokens.input), output: formatNumber(tokens.output) })}
            </div>
          )}
        </button>

        <ChildBranch sessions={spawned} onOpen={onOpenChild} />

        {isExpanded && (
          <div style={{ marginLeft: '1.75rem', borderTop: '1px solid var(--surface-subtle)' }}>
            <div className="group relative w-full overflow-auto" style={{ maxHeight: '26rem', background: 'var(--surface-background)' }}>
              <div className="absolute right-2 z-10 opacity-0 transition-opacity group-hover:opacity-100" style={{ top: 4 }}>
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCopy(json);
                  }}
                  aria-label={isCopied ? mittrT('mittr.activity.copied') : mittrT('mittr.activity.copyJson')}
                  title={isCopied ? mittrT('mittr.activity.copied') : mittrT('mittr.activity.copy')}
                >
                  {isCopied ? <Icon name="check" className="size-3.5" /> : <Icon name="file-copy" className="size-3.5" />}
                </button>
              </div>
              <React.Suspense fallback={<pre style={{ margin: 0, padding: '0.75rem', fontSize: 'var(--text-micro)', whiteSpace: 'pre-wrap' }}>{json}</pre>}>
                <WorkerHighlightedCode
                  language="json"
                  code={json}
                  style={{
                    margin: 0,
                    padding: '0.75rem',
                    background: 'transparent',
                    fontSize: 'var(--text-micro)',
                    lineHeight: '1.35',
                  }}
                  wrap
                />
              </React.Suspense>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export const ActivityTimeline: React.FC<ActivityTimelineProps> = ({ messages, childSessions, onOpenChild, timeFormatPreference, sessionKey }) => {
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [copied, setCopied] = React.useState<string | null>(null);
  const copyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  React.useEffect(() => {
    setExpanded((prev) => (Object.keys(prev).length > 0 ? {} : prev));
    setCopied(null);
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, [sessionKey]);

  const handleCopy = React.useCallback(async (messageId: string, value: string) => {
    const result = await copyTextToClipboard(value);
    if (!result.ok) {
      setCopied(null);
      return;
    }
    setCopied(messageId);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      setCopied((current) => (current === messageId ? null : current));
    }, COPY_FEEDBACK_MS);
  }, []);

  const childById = React.useMemo(() => new Map(childSessions.map((child) => [child.id, child])), [childSessions]);
  const orphans = React.useMemo(() => orphanChildren(messages, childSessions), [messages, childSessions]);
  const turns = React.useMemo(() => timelineTurns(messages), [messages]);

  const title = <div className="typography-micro text-muted-foreground">{mittrT('mittr.activity.title')}</div>;

  if (turns.length === 0) {
    return (
      <div data-activity-timeline="">
        {title}
        <div className="typography-meta text-muted-foreground" style={{ marginTop: 10 }}>{mittrT('mittr.activity.empty')}</div>
      </div>
    );
  }

  return (
    <div data-activity-timeline="">
      {title}
      <div style={{ marginTop: 12 }}>
        {turns.map(({ item: turn, dayHeading }, turnIndex) => {
          const prompt = turn.prompt;
          const key = (prompt ?? turn.steps[0]?.message)?.info.id ?? 'turn';

          return (
            <React.Fragment key={key}>
              {dayHeading !== null && (
                <div className="flex items-center gap-2.5" style={{ paddingTop: turnIndex === 0 ? 0 : 20, paddingBottom: 12 }}>
                  <span className="typography-meta text-muted-foreground">{formatMessagePreviewDay(dayHeading)}</span>
                  <span aria-hidden="true" style={{ height: 1, flex: 1, background: 'var(--surface-subtle)' }} />
                </div>
              )}

              {prompt && (
                <div style={{ position: 'relative', padding: '0.25rem 0 1rem 1.75rem' }}>
                  <Spine variant={turn.steps.length > 0 ? 'full' : 'half'} />
                  <Dot tone="prompt" />
                  <div className="typography-ui-header font-semibold text-foreground">
                    {deriveUserSnippet(prompt.parts) || mittrT('mittr.activity.roleUser')}
                  </div>
                  <div className="typography-micro text-muted-foreground tabular-nums" style={{ marginTop: 4 }}>
                    {formatMessagePreviewClock(readCreated(prompt), timeFormatPreference)}
                  </div>
                </div>
              )}

              {turnIndex === 0 && orphans.length > 0 && <ChildBranch sessions={orphans} onOpen={onOpenChild} />}

              {[...turn.steps].reverse().map(({ message, index, total }) => (
                <StepRow
                  key={message.info.id}
                  message={message}
                  spawned={readSpawnedSessionIds(message)
                    .map((id) => childById.get(id))
                    .filter((child): child is ChildSession => child !== undefined)}
                  onOpenChild={onOpenChild}
                  index={index}
                  total={total}
                  isExpanded={expanded[message.info.id] === true}
                  isCopied={copied === message.info.id}
                  onToggle={() => setExpanded((prev) => ({ ...prev, [message.info.id]: !(prev[message.info.id] === true) }))}
                  onCopy={(json) => { void handleCopy(message.info.id, json); }}
                />
              ))}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

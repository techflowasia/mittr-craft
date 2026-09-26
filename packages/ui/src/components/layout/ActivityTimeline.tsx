import React from 'react';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import { deriveMessageRole } from '@/components/chat/message/messageRole';
import { readTaskSessionIdFromRecord } from '@/components/chat/message/parts/taskToolModel';
import { Icon } from '@/components/icon/Icon';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';
import { copyTextToClipboard } from '@/lib/clipboard';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { TimeFormatPreference } from '@/stores/useUIStore';
import {
  deriveMessageLabel,
  deriveUserSnippet,
  formatMessagePreviewClock,
  formatMessagePreviewDay,
  formatStepDuration,
  groupIntoTurns,
  withDayHeadings,
} from './rawMessagePreview';

/**
 * The session's work as a timeline: a prompt, then the steps it caused, each
 * reporting who ran it, on what model, at what cost, and for how long.
 *
 * Laid out as a timeline rather than a table. The row it replaced packed the
 * same values into one line with the numbers right-aligned into columns, which
 * reads as a log: nothing is larger than anything else, so the eye has no
 * entry point and every row looks like the one above it. Here each step opens
 * with its name at the top of the type scale and steps down from there, and
 * the values stack under it left-aligned against the spine.
 *
 * Vertical rhythm is deliberately loose. Density was the previous layout's
 * whole problem, and a timeline that has to be scrolled is a smaller cost than
 * one that cannot be read.
 */

type SessionMessage = { info: Message; parts: Part[] };

type ChildSession = { id: string; title?: string };

type ActivityTimelineProps = {
  messages: SessionMessage[];
  /** Subagent sessions spawned by this one, in the order the store holds. */
  childSessions: ChildSession[];
  /** Opens a subagent's own transcript. */
  onOpenChild: (childId: string, label: string) => void;
  timeFormatPreference: TimeFormatPreference;
  /**
   * Identifies the conversation on screen. Expanded rows collapse when it
   * changes: message ids are unique across sessions, so state keyed by id
   * would otherwise survive a switch and reappear on the way back.
   */
  sessionKey: string;
};

const COPY_FEEDBACK_MS = 1500;

const formatNumber = (value: number): string => value.toLocaleString(getCurrentIntlLocale());

type TokenCounts = { input: number; output: number };

const nonNegative = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
);

/**
 * The input/output counters for a step, or null when it carries none.
 *
 * Null and zero are different answers: a step that reported `0 / 0` still ran
 * and its counters belong on screen, while a step with no token field at all
 * has nothing to say and should not render an empty pair of zeros.
 */
const readTokenCounts = (message: SessionMessage): TokenCounts | null => {
  const raw = (message.info as { tokens?: unknown }).tokens
    ?? (message.parts.find((part) => (part as { tokens?: unknown }).tokens !== undefined) as { tokens?: unknown } | undefined)?.tokens;
  if (!raw || typeof raw !== 'object') return null;
  const counts = raw as { input?: unknown; output?: unknown };
  return { input: nonNegative(counts.input), output: nonNegative(counts.output) };
};

const readCreated = (message: SessionMessage): number | null => (
  (message.info.time?.created ?? null) as number | null
);

// Only an assistant message carries a completion time; the union has no such
// field on the user side.
const readCompleted = (message: SessionMessage): number | null => (
  ((message.info.time as { completed?: number } | undefined)?.completed ?? null) as number | null
);

/**
 * The line the steps hang from.
 *
 * Filled with the theme's brand gradient rather than a border colour. A single
 * flat grey reads as a rule drawn between rows; a ramp reads as one line
 * travelling down the whole run, which is the difference between a list with
 * a divider and a timeline. The gradient is a theme token, so a theme that
 * defines its own ramp gets its own line.
 */
const Spine: React.FC<{ variant: 'full' | 'half'; inset?: boolean }> = ({ variant, inset = false }) => (
  <span
    className={cn(
      'absolute w-[2px] rounded-full opacity-70',
      inset ? 'left-[3px]' : 'left-[4px]',
      'bg-[image:var(--grad-brand)]',
      variant === 'full' ? 'top-0 h-full' : 'top-0 h-[1.25rem]',
    )}
    aria-hidden="true"
  />
);

const Dot: React.FC<{ tone: 'prompt' | 'step' | 'running' | 'child' }> = ({ tone }) => (
  <span
    className={cn(
      'absolute rounded-full',
      // The ring is the panel's own background, so the spine passes behind the
      // dot instead of through it, and the glow gives the dot a light source
      // instead of leaving it a flat disc.
      'ring-[3px] ring-[var(--surface-background)]',
      tone === 'child'
        ? 'left-0 top-[0.45rem] size-[8px] bg-[var(--primary-muted)]'
        : 'left-0 bg-[image:var(--grad-accent)]',
      tone === 'prompt' && 'top-[0.45rem] size-[11px] shadow-[0_0_10px_var(--primary-muted)]',
      tone === 'step' && 'top-[0.5rem] size-[10px] shadow-[0_0_8px_var(--primary-muted)]',
      tone === 'running' && 'top-[0.5rem] size-[10px] shadow-[0_0_12px_var(--primary)] animate-pulse',
    )}
    aria-hidden="true"
  />
);

/**
 * A subagent spawned by the step above it.
 *
 * Nested under its own step rather than listed beside the turn: the step is
 * what caused it, and a flat list would leave the reader to guess which `task`
 * call produced which agent when a turn spawns several.
 */
const ChildBranch: React.FC<{ sessions: { id: string; title?: string }[]; onOpen: (id: string, label: string) => void }> = ({ sessions, onOpen }) => {
  const { t } = useI18n();
  if (sessions.length === 0) return null;
  return (
    <div className="mt-1 mb-1 ml-7">
      {sessions.map((child) => {
        const label = child.title?.trim() || t('contextSidebar.activity.subagentUntitled');
        return (
          <div className="relative" key={child.id}>
            <Spine variant="full" inset />
            <Dot tone="child" />
            <button
              type="button"
              className="w-full cursor-pointer rounded-md py-1.5 pr-2 pl-6 text-left transition-colors hover:bg-[var(--interactive-hover)]"
              onClick={() => onOpen(child.id, label)}
            >
              <div className="typography-meta text-foreground">{label}</div>
              <div className="mt-0.5 typography-micro text-muted-foreground">
                {t('contextSidebar.activity.subagent')}
              </div>
            </button>
          </div>
        );
      })}
    </div>
  );
};

/**
 * The subagent sessions a step spawned, read from its own `task` parts.
 *
 * The join comes from the part, not from ordering: a turn can spawn several
 * agents, and pairing them by position would attach the wrong transcript to
 * the wrong step the first time one of them fails to report an id.
 */
const readSpawnedSessionIds = (message: SessionMessage): string[] => {
  const ids: string[] = [];
  for (const part of message.parts) {
    const record = part as unknown as Record<string, unknown>;
    if (record.type !== 'tool' || record.tool !== 'task') continue;
    const state = record.state as Record<string, unknown> | undefined;
    const id = readTaskSessionIdFromRecord(state?.metadata)
      ?? readTaskSessionIdFromRecord(record.metadata)
      ?? readTaskSessionIdFromRecord(state);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
};

type StepRowProps = {
  message: SessionMessage;
  /** Named `spawned` rather than `children`: React reserves that prop. */
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
  const { t } = useI18n();
  const label = deriveMessageLabel(message.parts);
  const info = message.info as Message & { agent?: string; modelID?: string };
  const created = readCreated(message);
  const completed = readCompleted(message);
  const duration = formatStepDuration(created, completed);
  // No end timestamp is the only evidence a step is still running; nothing
  // else here reports live state.
  const running = created !== null && completed === null;
  const tokens = deriveMessageRole(message.info).role === 'assistant' ? readTokenCounts(message) : null;
  const json = isExpanded ? JSON.stringify({ info: message.info, parts: message.parts }, null, 2) : '';

  return (
    <div className="relative">
      <Spine variant="full" />
      <Dot tone={running ? 'running' : 'step'} />
      <div className="overflow-hidden rounded-lg">
        <button
          type="button"
          className="w-full cursor-pointer rounded-lg py-2.5 pr-3 pl-7 text-left transition-colors hover:bg-[var(--interactive-hover)]"
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
            <div className="mt-1 typography-meta text-[var(--primary)]">
              {t('contextSidebar.activity.working')}
            </div>
          ) : (
            duration && (
              <div className="mt-1 typography-meta text-muted-foreground tabular-nums">
                {t('contextSidebar.activity.elapsed', { duration })}
              </div>
            )
          )}

          <div className="mt-1.5 typography-micro text-muted-foreground">
            {t('contextSidebar.activity.step', { index, total })}
          </div>

          <div className="mt-0.5 typography-micro text-muted-foreground">
            {[info.agent, info.modelID].filter(Boolean).join(' · ')}
          </div>

          {tokens && (
            <div
              className="mt-0.5 typography-micro text-muted-foreground tabular-nums"
              aria-label={t('contextSidebar.rawMessages.tokensAria', {
                input: formatNumber(tokens.input),
                output: formatNumber(tokens.output),
              })}
            >
              {t('contextSidebar.activity.tokens', {
                input: formatNumber(tokens.input),
                output: formatNumber(tokens.output),
              })}
            </div>
          )}
        </button>

        <ChildBranch sessions={spawned} onOpen={onOpenChild} />

        {isExpanded && (
          <div className="ml-7 border-t border-[var(--surface-subtle)]">
            <div className="group relative max-h-[26rem] w-full overflow-auto bg-[var(--surface-background)]">
              <div className="absolute top-1 right-2 z-10 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-interactive-hover/60 hover:text-foreground"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCopy(json);
                  }}
                  aria-label={isCopied ? t('contextSidebar.actions.copied') : t('contextSidebar.actions.copyJson')}
                  title={isCopied ? t('contextSidebar.actions.copied') : t('contextSidebar.actions.copy')}
                >
                  {isCopied ? <Icon name="check" className="size-3.5" /> : <Icon name="file-copy" className="size-3.5" />}
                </button>
              </div>
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
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export const ActivityTimeline: React.FC<ActivityTimelineProps> = ({ messages, childSessions, onOpenChild, timeFormatPreference, sessionKey }) => {
  const { t } = useI18n();
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
    // `copyTextToClipboard` resolves to a result object, not a boolean; an
    // object is always truthy, so a plain truth test would report every
    // failure as a success.
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

  // Turns are grouped in conversation order so a step's number is a fact about
  // the work, then reversed so the newest turn is the one already on screen.
  const childById = React.useMemo(
    () => new Map(childSessions.map((child) => [child.id, child])),
    [childSessions],
  );

  // A child whose spawning step is not on screen -- an agent started before
  // the loaded history, or one whose task part never reported its id -- would
  // otherwise vanish. Those are listed under the newest turn instead of being
  // dropped, because a missing join is not evidence the agent did not run.
  const claimedChildIds = React.useMemo(() => {
    const claimed = new Set<string>();
    for (const message of messages) {
      for (const id of readSpawnedSessionIds(message)) {
        if (childById.has(id)) claimed.add(id);
      }
    }
    return claimed;
  }, [messages, childById]);

  const orphanChildren = React.useMemo(
    () => childSessions.filter((child) => !claimedChildIds.has(child.id)),
    [childSessions, claimedChildIds],
  );

  const turns = React.useMemo(() => withDayHeadings(
    [...groupIntoTurns(messages, (message) => deriveMessageRole(message.info).role === 'user')].reverse(),
    (turn) => {
      const anchor = turn.prompt ?? turn.steps[0]?.message ?? null;
      return anchor ? readCreated(anchor) : null;
    },
  ), [messages]);

  if (messages.length === 0) {
    return (
      <div>
        <div className="typography-micro text-muted-foreground">{t('contextSidebar.activity.title')}</div>
        <div className="mt-2.5 typography-meta text-muted-foreground">{t('contextSidebar.activity.empty')}</div>
      </div>
    );
  }

  return (
    <div>
      <div className="typography-micro text-muted-foreground">{t('contextSidebar.activity.title')}</div>
      <div className="mt-3">
        {turns.map(({ item: turn, dayHeading }, turnIndex) => {
          const prompt = turn.prompt;
          const key = (prompt ?? turn.steps[0]?.message)?.info.id ?? 'turn';

          return (
            <React.Fragment key={key}>
              {dayHeading !== null && (
                <div className="flex items-center gap-2.5 pt-5 pb-3 first:pt-0">
                  <span className="typography-meta text-muted-foreground">
                    {formatMessagePreviewDay(dayHeading)}
                  </span>
                  <span className="h-px flex-1 bg-[var(--surface-subtle)]" aria-hidden="true" />
                </div>
              )}

              {prompt && (
                <div className="relative pt-1 pb-4 pl-7">
                  <Spine variant={turn.steps.length > 0 ? 'full' : 'half'} />
                  <Dot tone="prompt" />
                  <div className="typography-ui-header font-semibold text-foreground">
                    {deriveUserSnippet(prompt.parts) || t('contextSidebar.rawMessages.roleUser')}
                  </div>
                  <div className="mt-1 typography-micro text-muted-foreground tabular-nums">
                    {formatMessagePreviewClock(readCreated(prompt), timeFormatPreference)}
                  </div>
                </div>
              )}

              {turnIndex === 0 && orphanChildren.length > 0 && (
                <ChildBranch sessions={orphanChildren} onOpen={onOpenChild} />
              )}

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
                  onToggle={() => setExpanded((prev) => ({
                    ...prev,
                    [message.info.id]: !(prev[message.info.id] === true),
                  }))}
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

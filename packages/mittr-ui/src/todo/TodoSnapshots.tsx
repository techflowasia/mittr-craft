import React from 'react';

import { useChatTranscriptDirectory } from '../../../ui/src/components/chat/chatColumnSession';
import { useToolContentCompletion } from '../../../ui/src/components/chat/message/parts/useToolContentCompletion';
import { Icon } from '../../../ui/src/components/icon/Icon';
import type { IconName } from '../../../ui/src/components/icon/icons';
import { useI18n, type I18nKey } from '../../../ui/src/lib/i18n';
import type { Message, Part, ToolPart } from '../../../ui/src/lib/opencode/model';
import type { ProductSlotProps } from '../../../ui/src/lib/product-plugins';
import { useSessionMessagesSelector } from '../../../ui/src/sync/session-message-hooks';
import { isChecklistReplaced, latestTodoWriteOf, todoSnapshotOf, type TodoSnapshotItem } from './readTodoSnapshot';

const statuses = {
  pending: { icon: 'checkbox-blank-circle', label: 'chat.statusRow.todo.status.pending', tone: 'text-muted-foreground', text: 'text-foreground', spoken: true },
  in_progress: { icon: 'time', label: 'chat.statusRow.todo.status.inProgress', tone: 'text-[var(--status-info-text)]', text: 'text-foreground font-medium', spoken: false },
  completed: { icon: 'checkbox-circle', label: 'chat.statusRow.todo.status.completed', tone: 'text-[var(--status-success-text)]', text: 'text-muted-foreground', spoken: true },
  cancelled: { icon: 'close-circle', label: 'chat.statusRow.todo.status.cancelled', tone: 'text-muted-foreground', text: 'text-muted-foreground line-through', spoken: false },
} satisfies Record<TodoSnapshotItem['status'], { icon: IconName; label: I18nKey; tone: string; text: string; spoken: boolean }>;

const cardClass = 'my-2 rounded-lg bg-foreground/5 px-3 py-2.5';

function TodoSnapshot({ todos, partId }: { todos: TodoSnapshotItem[]; partId: string }): React.ReactNode {
  const { t } = useI18n();
  const done = todos.filter((item) => item.status === 'completed').length;
  return (
    <section aria-label={t('chat.statusRow.tasksTitle')} data-todo-snapshot={partId} className={`${cardClass} text-foreground`}>
      <div className="flex items-baseline justify-between gap-x-3">
        <h3 className="typography-ui-label font-medium">{t('chat.statusRow.tasksTitle')}</h3>
        <span className="typography-meta tabular-nums text-muted-foreground" data-todo-progress="">
          <span aria-hidden="true">{done}/{todos.length}</span>
          <span className="sr-only">{t('chat.todo.completed')}: {done}, {t('chat.todo.total')}: {todos.length}</span>
        </span>
      </div>
      {todos.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {todos.map((item) => {
            const status = statuses[item.status];
            return (
              <li key={item.id} className="flex items-start gap-2 typography-ui-label" data-todo-status={item.status}>
                <Icon name={status.icon} aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${status.tone}`} />
                <span className={`min-w-0 flex-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${status.text}`}>{item.content}</span>
                <span className={status.spoken ? 'sr-only' : `shrink-0 typography-meta ${status.tone}`}>{t(status.label)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function TodoLoadFailed({ retry }: { retry: () => void }): React.ReactNode {
  const { t } = useI18n();
  return (
    <section aria-label={t('chat.statusRow.tasksTitle')} data-todo-load-failed="" className={`${cardClass} flex flex-wrap items-baseline gap-x-3 gap-y-1 typography-meta text-muted-foreground`}>
      <h3 className="typography-ui-label font-medium text-foreground">{t('chat.statusRow.tasksTitle')}</h3>
      <span>{t('chat.toolPart.content.loadFailed')}</span>
      <button type="button" onClick={retry} className="rounded underline hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('chat.toolPart.content.retry')}</button>
    </section>
  );
}

function TodoWriteSnapshot({ part }: { part: ToolPart }): React.ReactNode {
  const storeDirectory = useChatTranscriptDirectory();
  const content = useToolContentCompletion(part, true, storeDirectory ?? undefined);
  if (content.status === 'loading') return null;
  if (content.status === 'failed') return <TodoLoadFailed retry={content.retry} />;
  const todos = todoSnapshotOf(part);
  return todos === null ? null : <TodoSnapshot partId={part.id} todos={todos} />;
}

function LatestTodoSnapshot({ part }: { part: ToolPart }): React.ReactNode {
  const directory = useChatTranscriptDirectory() ?? undefined;
  const { messageID } = part;
  const select = React.useCallback(
    (messages: Message[], state: { part: Record<string, Part[] | undefined> }) => isChecklistReplaced(messageID, messages, (id) => state.part[id] ?? []),
    [messageID],
  );
  const replaced = useSessionMessagesSelector(part.sessionID, directory, select, Object.is, true);
  return replaced ? null : <TodoWriteSnapshot part={part} />;
}

export function TodoSnapshots({ message }: ProductSlotProps['assistant-message-footer']): React.ReactNode {
  if (message.info.role !== 'assistant') return null;
  const latest = latestTodoWriteOf(message.parts.filter((part) => part.sessionID === message.info.sessionID && part.messageID === message.info.id));
  return latest ? <LatestTodoSnapshot key={latest.id} part={latest} /> : null;
}

import React from 'react';

import { Icon } from '../../../ui/src/components/icon/Icon';
import type { Message } from '../../../ui/src/lib/opencode/model';
import type { ProductSlotProps } from '../../../ui/src/lib/product-plugins';
import { useMittrT } from '../strings/mittrT';
import { substitutedAnswerOf, useAnsweredBy, type AnsweredBy, type AnsweredByList } from './answeredBy';

const MITTR_PROVIDER_ID = 'mittr';

export function AnsweredByNoticeView({ answer }: { answer: AnsweredBy }): React.ReactNode {
  const t = useMittrT();
  const values = { to: answer.answeredLabel, from: answer.requestedLabel };
  const text = answer.reason === 'quota' ? t('mittr.answeredBy.outOfQuota', values) : t('mittr.answeredBy.couldNotAnswer', values);
  return (
    <p className="mt-2 flex items-center gap-1.5 typography-meta text-muted-foreground" data-answered-by={answer.reason}>
      <Icon name="arrow-left-right" aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">{text}</span>
    </p>
  );
}

export function AnsweredByLine({ info, list }: { info: Message; list: AnsweredByList | undefined }): React.ReactNode {
  const answer = substitutedAnswerOf(info, list);
  return answer ? <AnsweredByNoticeView answer={answer} /> : null;
}

function AnsweredByLoaded({ info, completedAt }: { info: Message; completedAt: number }): React.ReactNode {
  const list = useAnsweredBy(info.sessionID, completedAt);
  return <AnsweredByLine info={info} list={list} />;
}

export function AnsweredByNotice({ message }: ProductSlotProps['assistant-message-footer']): React.ReactNode {
  const { info } = message;
  if (info.role !== 'assistant' || info.providerID !== MITTR_PROVIDER_ID || info.time.completed === undefined) return null;
  return <AnsweredByLoaded info={info} completedAt={info.time.completed} />;
}

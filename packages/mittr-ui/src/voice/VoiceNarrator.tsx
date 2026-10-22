import React from 'react';

import { useLatestSessionError } from '../../../ui/src/sync/notification-store';
import { useSessionUIStore } from '../../../ui/src/sync/session-ui-store';
import { useSession, useSessionPermissions, useSessionStatus } from '../../../ui/src/sync/sync-context';
import { createNarrationWatch, endingOf, spokenText, type NarrationWatch } from './narration';
import { useTalkState } from './talkStore';

export function VoiceNarrator(): null {
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const directory = useSessionUIStore((state) => state.currentSessionDirectory) ?? undefined;
  const status = useSessionStatus(sessionId ?? '', directory);
  const permissions = useSessionPermissions(sessionId ?? '', directory);
  const latestError = useLatestSessionError(sessionId ?? '');
  const ending = endingOf(useSession(sessionId, directory));
  const narrate = useTalkState((state) => state.narrate);
  const watch = React.useRef<NarrationWatch | null>(null);
  if (!watch.current) watch.current = createNarrationWatch();

  const busy = status?.type === 'busy';
  const permissionKey = permissions.map((request) => request.id).join('\n');
  const errorAt = latestError?.time ?? null;
  const aborted = latestError?.error?.name === 'MessageAbortedError';
  const endedAt = ending?.at ?? null;
  const outcome = ending?.outcome ?? null;

  React.useEffect(() => {
    const events = watch.current?.observe({
      sessionId,
      busy,
      permissionIds: permissionKey ? permissionKey.split('\n') : [],
      error: errorAt === null ? null : { at: errorAt, aborted },
      ended: endedAt === null ? null : { at: endedAt, outcome },
    }) ?? [];
    for (const event of events) narrate(spokenText(event), event);
  }, [narrate, sessionId, busy, permissionKey, errorAt, aborted, endedAt, outcome]);

  return null;
}

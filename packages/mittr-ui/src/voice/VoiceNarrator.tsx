import React from 'react';

import { useLatestSessionError } from '../../../ui/src/sync/notification-store';
import { useSessionUIStore } from '../../../ui/src/sync/session-ui-store';
import { useSessionPermissions, useSessionStatus } from '../../../ui/src/sync/sync-context';
import { createNarrationWatch, spokenText, type NarrationWatch } from './narration';
import { claimNarrator, releaseNarrator, useTalkState } from './talkStore';

export function VoiceNarrator(): null {
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const directory = useSessionUIStore((state) => state.currentSessionDirectory) ?? undefined;
  const status = useSessionStatus(sessionId ?? '', directory);
  const permissions = useSessionPermissions(sessionId ?? '', directory);
  const latestError = useLatestSessionError(sessionId ?? '');
  const narrate = useTalkState((state) => state.narrate);
  const watch = React.useRef<NarrationWatch | null>(null);
  if (!watch.current) watch.current = createNarrationWatch();

  const busy = status?.type === 'busy';
  const permissionKey = permissions.map((request) => request.id).join('\n');
  const errorAt = latestError?.time ?? null;
  const aborted = latestError?.error?.name === 'MessageAbortedError';

  React.useEffect(() => {
    const events = watch.current?.observe({
      sessionId,
      busy,
      permissionIds: permissionKey ? permissionKey.split('\n') : [],
      error: errorAt === null ? null : { at: errorAt, aborted },
    }) ?? [];
    for (const event of events) narrate(spokenText(event), event);
  }, [narrate, sessionId, busy, permissionKey, errorAt, aborted]);

  return null;
}

export function useNarratorClaim(): boolean {
  const id = React.useId();
  const narrator = useTalkState((state) => state.narrator);
  React.useEffect(() => {
    if (narrator === null) claimNarrator(id);
  }, [id, narrator]);
  React.useEffect(() => () => releaseNarrator(id), [id]);
  return narrator === id;
}

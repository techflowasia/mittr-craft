import React from 'react';

import { isVSCodeRuntime } from '@/lib/desktop';
import type { ProductSlotProps } from '@/lib/product-plugins';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllLiveSessions } from '@/sync/sync-context';
import { ActivityTimeline } from './ActivityTimeline';
import { openChildSession } from './openChild';

export const ContextActivity: React.FC<ProductSlotProps['context-raw-messages']> = ({ sessionId, directory, messages }) => {
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const isMobile = useUIStore((state) => state.isMobile);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const liveSessions = useAllLiveSessions();
  const childSessions = React.useMemo(
    () => liveSessions.filter((candidate) => candidate.parentID === sessionId),
    [liveSessions, sessionId],
  );
  const onOpenChild = React.useCallback((childId: string, label: string) => {
    openChildSession({
      directory,
      isMobile,
      isVSCode: isVSCodeRuntime(),
      setCurrentSession: (id, dir) => setCurrentSession(id, dir),
      openContextPanelTab: (dir, tab) => openContextPanelTab(dir, tab),
    }, childId, label);
  }, [directory, isMobile, openContextPanelTab, setCurrentSession]);

  return (
    <ActivityTimeline
      messages={messages}
      childSessions={childSessions}
      onOpenChild={onOpenChild}
      timeFormatPreference={timeFormatPreference}
      sessionKey={`${directory ?? ''}::${sessionId}`}
    />
  );
};

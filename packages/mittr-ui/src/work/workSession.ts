import React from 'react';

import { toast } from '../../../ui/src/components/ui';
import { useConfigStore } from '../../../ui/src/stores/useConfigStore';
import { useUIStore } from '../../../ui/src/stores/useUIStore';
import * as sessionActions from '../../../ui/src/sync/session-actions';
import { useSessionUIStore } from '../../../ui/src/sync/session-ui-store';
import { listenAnyAccountChange } from '../sign-in/accountChange';
import { signedInAccount } from '../sign-in/signedInAccount';
import type { GoWorkDeps } from './goWork';
import { createMyWorkController, type MyWorkController } from './myWorkController';
import { fetchMyWork } from './workApi';

export function useMyWorkController(): MyWorkController | null {
  const [controller, setController] = React.useState<MyWorkController | null>(null);
  React.useEffect(() => {
    const created = createMyWorkController({
      fetchWork: () => fetchMyWork(),
      currentUserId: signedInAccount,
      listenAccountChanged: listenAnyAccountChange,
    });
    setController(created);
    void created.refresh();
    return () => created.dispose();
  }, []);
  return controller;
}

export const sessionGoWorkDeps = (closeDialog: () => void, reload: () => void): GoWorkDeps => ({
  createSession: (title, directory, selection) => sessionActions.createSession(
    title,
    directory,
    undefined,
    undefined,
    { model: { providerID: selection.providerID, id: selection.modelID, variant: selection.variant }, agent: selection.agentName },
    'open',
  ),
  initialize: (sessionId) => {
    useSessionUIStore.getState().initializeNewOpenChamberSession(sessionId, useConfigStore.getState().agents);
  },
  sendMessage: (prompt, selection, sessionId, directory) => useSessionUIStore.getState().sendMessage(
    prompt,
    selection.providerID,
    selection.modelID,
    selection.agentName,
    undefined,
    undefined,
    undefined,
    selection.variant,
    undefined,
    { sessionId, directory },
  ),
  closeDialog: () => {
    closeDialog();
    useUIStore.getState().closeMainSurfaces();
  },
  reload,
  toast: {
    success: (message) => { toast.success(message); },
    error: (message, options) => { toast.error(message, options); },
  },
});

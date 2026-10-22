import React from 'react';
import { createPortal } from 'react-dom';

import { isVSCodeRuntime } from '../../../ui/src/lib/desktop';
import { useConfigStore } from '../../../ui/src/stores/useConfigStore';
import { useDirectoryStore } from '../../../ui/src/stores/useDirectoryStore';
import { normalizeContextPanelDirectoryKey, useUIStore } from '../../../ui/src/stores/useUIStore';
import { useSessionUIStore } from '../../../ui/src/sync/session-ui-store';
import { MittrErrorBoundary } from '../MittrErrorBoundary';
import type { MittrSurface } from '../mittrSurface';
import { listenAnyAccountChange } from '../sign-in/accountChange';
import { signedInAccount } from '../sign-in/signedInAccount';
import { useMittrT } from '../strings/mittrT';
import { startConversationListening } from './listen';
import { queueSpokenPrompt, queuedPromptCount } from './queue';
import { startSpeechStateClient } from './speechStateClient';
import { createUpstreamSpeech, storageFirstRunMark } from './upstreamSpeech';
import { createVoiceApi } from './voiceApi';
import { VoiceBar } from './VoiceBar';
import { createVoiceController, type SavedSpeechChoices, type VoiceController } from './voiceController';
import { VoiceQuotaText } from './VoiceQuotaText';
import { browserPlayer, voiceFetch } from './voiceRuntime';
import type { VoiceTurnContext } from './voiceSession';

function browserPanelOpen(directory: string): boolean {
  const panel = useUIStore.getState().contextPanelByDirectory[normalizeContextPanelDirectoryKey(directory)];
  return !!panel?.isOpen && panel.tabs.some((tab) => tab.id === panel.activeTabId && tab.mode === 'browser');
}

function viewedSession(): VoiceTurnContext {
  const { currentSessionId, currentSessionDirectory } = useSessionUIStore.getState();
  const directory = currentSessionDirectory ?? useDirectoryStore.getState().currentDirectory ?? undefined;
  const context: VoiceTurnContext = {};
  if (directory) {
    context.directory = directory;
    context.panelOpen = browserPanelOpen(directory);
  }
  if (currentSessionId) context.sessionId = currentSessionId;
  const queuedPrompts = queuedPromptCount(currentSessionId, directory);
  if (queuedPrompts !== undefined) context.queuedPrompts = queuedPrompts;
  return context;
}

function readStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function savedChoices(): SavedSpeechChoices {
  const storage = readStorage();
  const saved = (key: string) => {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  return {
    vscode: isVSCodeRuntime(),
    savedSttProvider: saved('sttProvider') !== null,
    savedVoiceProvider: saved('voiceProvider') !== null,
    localModelSaved: Boolean(saved('sttLocalModel')),
  };
}

function browserController(): VoiceController {
  return createVoiceController({
    api: createVoiceApi(voiceFetch),
    listen: startConversationListening,
    createPlayer: browserPlayer,
    context: viewedSession,
    queue: (event) => queueSpokenPrompt(event),
    speech: createUpstreamSpeech({ config: () => useConfigStore.getState(), fetch: voiceFetch }),
    savedChoices,
    firstRunMark: storageFirstRunMark(readStorage()),
    startSpeechState: () => startSpeechStateClient({ fetch: voiceFetch }),
    watchAccount: listenAnyAccountChange,
    account: signedInAccount,
    window,
  });
}

export function MittrVoiceRoot({ createController = browserController }: { createController?: () => VoiceController }): React.ReactNode {
  const t = useMittrT();
  const [controller] = React.useState(createController);
  const { session } = controller;
  const snapshot = React.useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const open = snapshot.phase !== 'idle';

  React.useEffect(() => controller.attach(), [controller]);

  if (!open && !snapshot.error && !snapshot.quota) return null;

  return createPortal(
    <div className="pointer-events-none fixed bottom-48 right-4 z-40 flex flex-col items-end gap-2">
      {open ? (
        <>
          <VoiceBar snapshot={snapshot} onEnd={controller.end} className="pointer-events-auto" />
        </>
      ) : null}
      {!open && snapshot.error ? (
        <p role="alert" className="pointer-events-auto max-w-[16rem] rounded-md bg-[var(--surface-elevated)] px-2 py-1 typography-micro text-[var(--status-error)] shadow-sm">
          {t(snapshot.error)}
        </p>
      ) : null}
      {!open && !snapshot.error && snapshot.quota ? (
        <p role="alert" className="pointer-events-auto max-w-[16rem] rounded-md bg-[var(--surface-elevated)] px-2 py-1 typography-micro text-[var(--status-warning)] shadow-sm">
          <VoiceQuotaText notice={snapshot.quota} />
        </p>
      ) : null}
    </div>,
    document.body,
  );
}

export function MittrVoiceMount({ surface }: { surface: MittrSurface }): React.ReactNode {
  if (surface !== 'main') return null;
  return (
    <MittrErrorBoundary fallback={null}>
      <MittrVoiceRoot />
    </MittrErrorBoundary>
  );
}

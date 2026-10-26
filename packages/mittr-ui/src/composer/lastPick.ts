import React from 'react';

import { isApplyingServerSettings, updateDesktopSettings } from '../../../ui/src/lib/persistence';
import { useConfigStore } from '../../../ui/src/stores/useConfigStore';
import { useSelectionStore } from '../../../ui/src/sync/selection-store';
import { useSessionUIStore } from '../../../ui/src/sync/session-ui-store';
import { mittrPickerDecorations, useProviderLock } from '../providers/useMittrPickerFilter';
import { signedInAccount } from '../sign-in/signedInAccount';

type ConfigState = ReturnType<typeof useConfigStore.getState>;

export type PickDefaults = { defaultModel?: string; defaultVariant?: string; defaultAgent?: string };

export type LastPickDeps = {
  isProviderOffered: (providerId: string) => boolean;
  signedIn: () => boolean;
  save: (defaults: PickDefaults) => void;
};

type ChatRecord = { model: string | null; agent: string | null; variant: string | null | undefined };

type Batch = { before: ConfigState; sessionId: string | null; record: ChatRecord | null };

const modelOf = (state: ConfigState): string | null => (
  state.currentProviderId && state.currentModelId ? `${state.currentProviderId}/${state.currentModelId}` : null
);

const selectionMoved = (next: ConfigState, prev: ConfigState): boolean => (
  modelOf(next) !== modelOf(prev)
  || next.currentAgentName !== prev.currentAgentName
  || next.currentVariant !== prev.currentVariant
  || next.currentVariantSelection.override !== prev.currentVariantSelection.override
);

const chatRecord = (sessionId: string | null, state: ConfigState): ChatRecord | null => {
  if (!sessionId) return null;
  const selection = useSelectionStore.getState();
  const model = selection.getSessionModelSelection(sessionId);
  return {
    model: model ? `${model.providerId}/${model.modelId}` : null,
    agent: selection.getSessionAgentSelection(sessionId),
    variant: state.currentAgentName
      ? selection.getAgentModelVariantForSession(sessionId, state.currentAgentName, state.currentProviderId, state.currentModelId)
      : undefined,
  };
};

const pickedDefaults = ({ before, record }: Batch, now: ConfigState, isProviderOffered: (providerId: string) => boolean): PickDefaults => {
  const defaults: PickDefaults = {};
  const model = modelOf(now);
  const modelMoved = model !== modelOf(before);
  const override = now.currentVariantSelection.override;
  const modelPicked = modelMoved && now.selectionSource === 'manual' && model !== record?.model;
  const effortPicked = !modelMoved
    && override !== undefined
    && (override !== before.currentVariantSelection.override || now.currentVariant !== before.currentVariant)
    && !(record && record.variant === override);
  if (model && (modelPicked || effortPicked) && isProviderOffered(now.currentProviderId)
    && (model !== now.settingsDefaultModel || now.currentVariant !== now.settingsDefaultVariant)) {
    defaults.defaultModel = model;
    defaults.defaultVariant = now.currentVariant ?? '';
  }
  const agent = now.currentAgentName;
  if (agent && now.agentSelectionSource === 'manual' && agent !== before.currentAgentName
    && agent !== record?.agent && agent !== now.settingsDefaultAgent) {
    defaults.defaultAgent = agent;
  }
  return defaults;
};

const keepSelection = (state: ConfigState) => ({
  currentProviderId: state.currentProviderId,
  currentModelId: state.currentModelId,
  currentVariant: state.currentVariant,
  currentVariantSelection: state.currentVariantSelection,
  currentAgentName: state.currentAgentName,
  selectionSource: state.selectionSource,
  agentSelectionSource: state.agentSelectionSource,
  directoryScoped: state.directoryScoped,
});

export function startLastPickMemory({ isProviderOffered, signedIn, save }: LastPickDeps): () => void {
  let batch: Batch | null = null;
  let writing = false;
  let stopped = false;

  const record = (defaults: PickDefaults) => {
    const kept = keepSelection(useConfigStore.getState());
    writing = true;
    try {
      const store = useConfigStore.getState();
      if (defaults.defaultModel !== undefined) {
        store.setSettingsDefaultVariant(defaults.defaultVariant || undefined);
        store.setSettingsDefaultModel(defaults.defaultModel);
      }
      if (defaults.defaultAgent !== undefined) store.setSettingsDefaultAgent(defaults.defaultAgent);
      useConfigStore.setState(kept);
    } finally {
      writing = false;
    }
    save(defaults);
  };

  const flush = () => {
    const done = batch;
    batch = null;
    if (!done || stopped || !signedIn()) return;
    if (useSessionUIStore.getState().currentSessionId !== done.sessionId) return;
    const defaults = pickedDefaults(done, useConfigStore.getState(), isProviderOffered);
    if (Object.keys(defaults).length > 0) record(defaults);
  };

  const stop = useConfigStore.subscribe((state, prev) => {
    if (writing || batch || isApplyingServerSettings() || !selectionMoved(state, prev)) return;
    const sessionId = useSessionUIStore.getState().currentSessionId;
    batch = { before: prev, sessionId, record: chatRecord(sessionId, state) };
    queueMicrotask(flush);
  });

  return () => {
    stopped = true;
    stop();
  };
}

export function MittrLastPick(): null {
  const { controller } = useProviderLock();
  React.useEffect(() => startLastPickMemory({
    isProviderOffered: (providerId) => mittrPickerDecorations(controller.snapshot()).isProviderShown(providerId),
    signedIn: () => signedInAccount() !== null,
    save: (defaults) => {
      void updateDesktopSettings(defaults).catch(() => {});
    },
  }), [controller]);
  return null;
}

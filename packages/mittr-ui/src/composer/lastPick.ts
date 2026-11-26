import React from 'react';

import { readEffortRevision } from '../../../ui/src/lib/modelEfforts';
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

type Pick = { sessionId: string; value: string | null };

type Batch = {
  before: ConfigState;
  sessionId: string | null;
  recordAgent: string | null;
  agentPick: string | null;
  modelPick: string | null;
  effortRevision: number;
};

const modelOf = (state: ConfigState): string | null => (
  state.currentProviderId && state.currentModelId ? `${state.currentProviderId}/${state.currentModelId}` : null
);

const selectionMoved = (next: ConfigState, prev: ConfigState): boolean => (
  modelOf(next) !== modelOf(prev)
  || next.currentAgentName !== prev.currentAgentName
  || next.currentVariant !== prev.currentVariant
  || next.currentVariantSelection.override !== prev.currentVariantSelection.override
);

const effortRevision = (state: ConfigState): number => readEffortRevision(state.currentProviderId, state.currentModelId);

const pickedDefaults = ({ before, sessionId, recordAgent, agentPick, modelPick, effortRevision: startRevision }: Batch, now: ConfigState, isProviderOffered: (providerId: string) => boolean): PickDefaults => {
  const defaults: PickDefaults = {};
  const model = modelOf(now);
  const modelMoved = model !== modelOf(before);
  const override = now.currentVariantSelection.override;
  const modelPicked = modelMoved && now.selectionSource === 'manual' && (sessionId === null || model === modelPick);
  const effortPicked = !modelMoved
    && override !== undefined
    && (override !== before.currentVariantSelection.override || now.currentVariant !== before.currentVariant)
    && (sessionId === null || effortRevision(now) !== startRevision);
  if (model && (modelPicked || effortPicked) && isProviderOffered(now.currentProviderId)
    && (model !== now.settingsDefaultModel || now.currentVariant !== now.settingsDefaultVariant)) {
    defaults.defaultModel = model;
    defaults.defaultVariant = now.currentVariant ?? '';
  }
  const agent = now.currentAgentName;
  if (agent && now.agentSelectionSource === 'manual' && agent !== before.currentAgentName
    && (agent !== recordAgent || agent === agentPick) && agent !== now.settingsDefaultAgent) {
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
  let agentPick: Pick | null = null;
  let modelPick: Pick | null = null;
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

  const noteAgentPick = (sessionId: string, agent: string | null) => {
    const pick: Pick = { sessionId, value: agent };
    agentPick = pick;
    queueMicrotask(() => {
      if (agentPick === pick) agentPick = null;
    });
  };

  const noteModelPick = (sessionId: string, model: string) => {
    if (batch) {
      if (batch.sessionId === sessionId) batch.modelPick = model;
      return;
    }
    const pick: Pick = { sessionId, value: model };
    modelPick = pick;
    queueMicrotask(() => {
      if (modelPick === pick) modelPick = null;
    });
  };

  const stopPicks = useSelectionStore.subscribe((state, prev) => {
    const sessionId = useSessionUIStore.getState().currentSessionId;
    if (!sessionId) return;
    if (state.sessionPickedAgents !== prev.sessionPickedAgents
      && state.sessionAgentSelections !== prev.sessionAgentSelections
      && state.sessionFollowedAgents === prev.sessionFollowedAgents) {
      noteAgentPick(sessionId, state.sessionAgentSelections.get(sessionId) ?? null);
    }
    if (state.sessionPickedModels !== prev.sessionPickedModels) {
      const model = state.getSessionModelPick(sessionId);
      if (model && ![...prev.sessionPickedModels.values()].includes(model)) noteModelPick(sessionId, `${model.providerId}/${model.modelId}`);
    }
  });

  const stop = useConfigStore.subscribe((state, prev) => {
    if (writing || batch || isApplyingServerSettings() || !selectionMoved(state, prev)) return;
    const sessionId = useSessionUIStore.getState().currentSessionId;
    const pickFor = (pick: Pick | null): string | null => (pick && pick.sessionId === sessionId ? pick.value : null);
    batch = {
      before: prev,
      sessionId,
      recordAgent: sessionId ? useSelectionStore.getState().getSessionAgentSelection(sessionId) : null,
      agentPick: pickFor(agentPick),
      modelPick: pickFor(modelPick),
      effortRevision: effortRevision(state),
    };
    queueMicrotask(flush);
  });

  return () => {
    stopped = true;
    stopPicks();
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

import React from 'react';

import { useConfigStore } from '../../../ui/src/stores/useConfigStore';
import { useSmallModelStore } from '../../../ui/src/stores/useSmallModelStore';
import { signedInAccount, watchSignedInAccount } from '../sign-in/signedInAccount';
import { mittrCatalogAliases } from '../work/goWork';

export type SmallModelRefreshDeps = {
  mittrModels: () => readonly string[];
  subscribeModels: (onChange: () => void) => () => void;
  signedIn: () => string | null;
  subscribeSignedIn: (onChange: () => void) => () => void;
  invalidate: () => void;
};

const keyOf = (models: readonly string[]): string => JSON.stringify([...new Set(models)].sort());

export function watchMittrSmallModel({ mittrModels, subscribeModels, signedIn, subscribeSignedIn, invalidate }: SmallModelRefreshDeps): () => void {
  let modelKey = keyOf(mittrModels());
  let account = signedIn();
  const stopModels = subscribeModels(() => {
    const next = keyOf(mittrModels());
    if (next === modelKey) return;
    modelKey = next;
    invalidate();
  });
  const stopSignedIn = subscribeSignedIn(() => {
    const next = signedIn();
    if (next === account) return;
    account = next;
    if (next !== null) invalidate();
  });
  return () => {
    stopModels();
    stopSignedIn();
  };
}

export function startMittrSmallModelRefresh(): () => void {
  return watchMittrSmallModel({
    mittrModels: () => mittrCatalogAliases(useConfigStore.getState().providers),
    subscribeModels: (onChange) => useConfigStore.subscribe(onChange),
    signedIn: signedInAccount,
    subscribeSignedIn: watchSignedInAccount,
    invalidate: () => useSmallModelStore.getState().invalidate(),
  });
}

export function MittrSmallModelRefresh(): null {
  React.useEffect(() => startMittrSmallModelRefresh(), []);
  return null;
}

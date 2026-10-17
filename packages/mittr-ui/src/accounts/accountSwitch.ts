import React from 'react';

import { accountsApi, type SwitchOutcome } from './accountsApi';

export type AccountSwitchState = 'idle' | 'switching' | 'not-restarted' | 'failed';

type SwitchRequest = () => Promise<SwitchOutcome>;

export type AccountSwitchDeps = { retrySwitch: SwitchRequest };

export type AccountSwitch = {
  state: () => AccountSwitchState;
  subscribe: (listener: () => void) => () => void;
  run: (request: SwitchRequest, onDone: (outcome: SwitchOutcome) => void) => Promise<void>;
  retry: () => Promise<void>;
  dismiss: () => void;
};

export function createAccountSwitch({ retrySwitch }: AccountSwitchDeps): AccountSwitch {
  let current: AccountSwitchState = 'idle';
  let lastRequest: SwitchRequest | null = null;
  let finish: ((outcome: SwitchOutcome) => void) | null = null;
  const listeners = new Set<() => void>();

  const show = (next: AccountSwitchState) => {
    if (next === current) return;
    current = next;
    for (const listener of listeners) listener();
  };

  const send = async (request: SwitchRequest) => {
    lastRequest = request;
    show('switching');
    let outcome: SwitchOutcome;
    try {
      outcome = await request();
    } catch {
      show('failed');
      return;
    }
    if (outcome.engineRestarted === false) {
      show('not-restarted');
      return;
    }
    finish?.(outcome);
  };

  return {
    state: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    run: async (request, onDone) => {
      if (current !== 'idle') return;
      finish = onDone;
      await send(request);
    },
    retry: async () => {
      if (current === 'not-restarted') await send(retrySwitch);
      else if (current === 'failed' && lastRequest) await send(lastRequest);
    },
    dismiss: () => {
      if (current !== 'failed') return;
      finish = null;
      lastRequest = null;
      show('idle');
    },
  };
}

export type SignOutDeps = {
  signOutActive: () => Promise<SwitchOutcome>;
  onSignedOut: (signedIn: boolean) => void;
  accountSwitch?: AccountSwitch;
};

export function runSignOut({
  signOutActive,
  onSignedOut,
  accountSwitch = createAccountSwitch({ retrySwitch: accountsApi.retrySwitch }),
}: SignOutDeps): Promise<void> {
  return accountSwitch.run(signOutActive, (outcome) => onSignedOut(outcome.signedIn));
}

export const reloadWindow = (): void => {
  window.location.reload();
};

export type AccountSwitchBinding = { accountSwitch: AccountSwitch; state: AccountSwitchState };

export function useAccountSwitch(deps: AccountSwitchDeps): AccountSwitchBinding {
  const [accountSwitch] = React.useState(() => createAccountSwitch(deps));
  const state = React.useSyncExternalStore(accountSwitch.subscribe, accountSwitch.state, accountSwitch.state);
  return { accountSwitch, state };
}
